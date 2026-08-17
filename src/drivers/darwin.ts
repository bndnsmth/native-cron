import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ParsedCalendarCronExpression, ParsedCronExpression } from "../cron-expression";
import type { DriverContext, NativeCronDriver } from "../driver";
import { xmlEscape } from "../escape";
import { atomicWrite, ensureOutputDirectory, pathExists } from "../files";
import { NativeCommandError, runChecked } from "../process";
import type { JobStatus, NormalizedCronOptions } from "../types";

interface CalendarValue {
  key: "Minute" | "Hour" | "Day" | "Month" | "Weekday";
  values: readonly number[] | undefined;
}

function cartesianCalendar(
  values: readonly CalendarValue[],
): readonly Readonly<Record<string, number>>[] {
  let entries: readonly Readonly<Record<string, number>>[] = [{}];

  for (const value of values) {
    if (!value.values) {
      continue;
    }
    entries = entries.flatMap((entry) =>
      value.values!.map((item) => ({ ...entry, [value.key]: item })),
    );
  }

  return entries;
}

function calendarEntries(
  schedule: ParsedCalendarCronExpression,
): readonly Readonly<Record<string, number>>[] {
  const common: readonly CalendarValue[] = [
    { key: "Minute", values: schedule.minute.wildcard ? undefined : schedule.minute.values },
    { key: "Hour", values: schedule.hour.wildcard ? undefined : schedule.hour.values },
    { key: "Month", values: schedule.month.wildcard ? undefined : schedule.month.values },
  ];
  const day = schedule.dayOfMonth.wildcard ? undefined : schedule.dayOfMonth.values;
  const weekday = schedule.dayOfWeek.wildcard ? undefined : schedule.dayOfWeek.values;

  if (day && weekday) {
    return [
      ...cartesianCalendar([...common, { key: "Day", values: day }]),
      ...cartesianCalendar([...common, { key: "Weekday", values: weekday }]),
    ];
  }

  return cartesianCalendar([
    ...common,
    { key: "Day", values: day },
    { key: "Weekday", values: weekday },
  ]);
}

function renderCalendar(schedule: ParsedCalendarCronExpression): string {
  const entries = calendarEntries(schedule);
  if (entries.length > 10_000) {
    throw new Error(
      `Cron expression expands to ${entries.length.toLocaleString()} launchd intervals; simplify it`,
    );
  }

  const dictionaries = entries.map((entry) => {
    const fields = Object.entries(entry)
      .map(([key, value]) => `        <key>${key}</key>\n        <integer>${value}</integer>`)
      .join("\n");
    return `      <dict>${fields ? `\n${fields}\n      ` : ""}</dict>`;
  });

  return `<array>\n${dictionaries.join("\n")}\n    </array>`;
}

function renderStringMap(values: Readonly<Record<string, string>>): string {
  const entries = Object.entries(values);
  if (entries.length === 0) {
    return "";
  }
  return `\n    <key>EnvironmentVariables</key>\n    <dict>\n${entries
    .map(
      ([key, value]) =>
        `      <key>${xmlEscape(key)}</key>\n      <string>${xmlEscape(value)}</string>`,
    )
    .join("\n")}\n    </dict>`;
}

export function renderLaunchdPlist(
  options: NormalizedCronOptions,
  schedule: ParsedCronExpression,
): string {
  const label = `native-cron.${options.name}`;
  const argumentsXml = options.command
    .map((argument) => `      <string>${xmlEscape(argument)}</string>`)
    .join("\n");
  const stdout = options.stdout
    ? `\n    <key>StandardOutPath</key>\n    <string>${xmlEscape(options.stdout)}</string>`
    : "";
  const stderr = options.stderr
    ? `\n    <key>StandardErrorPath</key>\n    <string>${xmlEscape(options.stderr)}</string>`
    : "";
  const trigger =
    schedule.trigger === "startup"
      ? "<key>RunAtLoad</key>\n    <true/>"
      : `<key>StartCalendarInterval</key>\n    ${renderCalendar(schedule)}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xmlEscape(label)}</string>
    <key>ProgramArguments</key>
    <array>
${argumentsXml}
    </array>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(options.cwd)}</string>${renderStringMap(options.env)}
    ${trigger}${stdout}${stderr}
</dict>
</plist>
`;
}

export class DarwinDriver implements NativeCronDriver {
  readonly platform = "darwin" as const;
  readonly #context: DriverContext;

  constructor(context: DriverContext) {
    this.#context = context;
  }

  #path(name: string): string {
    return join(this.#context.home, "Library", "LaunchAgents", `native-cron.${name}.plist`);
  }

  #label(name: string): string {
    return `native-cron.${name}`;
  }

  #service(name: string): string {
    return `gui/${this.#context.uid}/${this.#label(name)}`;
  }

  async preflight(options: NormalizedCronOptions, schedule: ParsedCronExpression): Promise<void> {
    renderLaunchdPlist(options, schedule);
  }

  async #bootout(name: string): Promise<void> {
    const result = await this.#context.runner.run("launchctl", ["bootout", this.#service(name)]);
    if (result.code !== 0 && result.code !== 3 && result.code !== 113) {
      throw new NativeCommandError(`launchctl bootout ${this.#service(name)}`, result);
    }
  }

  async #setEnabled(name: string, enabled: boolean): Promise<void> {
    await runChecked(this.#context.runner, "launchctl", [
      enabled ? "enable" : "disable",
      this.#service(name),
    ]);
  }

  async register(options: NormalizedCronOptions, schedule: ParsedCronExpression): Promise<void> {
    await this.preflight(options, schedule);
    await Promise.all([
      ensureOutputDirectory(options.stdout),
      ensureOutputDirectory(options.stderr),
    ]);
    const path = this.#path(options.name);
    await atomicWrite(path, renderLaunchdPlist(options, schedule));
    await this.#bootout(options.name);
    await this.#setEnabled(options.name, true);
    await runChecked(this.#context.runner, "launchctl", [
      "bootstrap",
      `gui/${this.#context.uid}`,
      path,
    ]);
  }

  async start(name: string): Promise<void> {
    const path = this.#path(name);
    if (!(await pathExists(path))) {
      throw new Error(`Cron job '${name}' is not registered`);
    }
    await this.#bootout(name);
    await this.#setEnabled(name, true);
    await runChecked(this.#context.runner, "launchctl", [
      "bootstrap",
      `gui/${this.#context.uid}`,
      path,
    ]);
  }

  async stop(name: string): Promise<void> {
    await this.#setEnabled(name, false);
    await this.#bootout(name);
  }

  async remove(name: string): Promise<void> {
    await this.#bootout(name);
    await rm(this.#path(name), { force: true });
    await this.#setEnabled(name, true);
  }

  async status(name: string): Promise<JobStatus> {
    const path = this.#path(name);
    const exists = await pathExists(path);
    const result = await this.#context.runner.run("launchctl", ["print", this.#service(name)]);
    if (result.code !== 0 && result.code !== 3 && result.code !== 113) {
      throw new NativeCommandError(`launchctl print ${this.#service(name)}`, result);
    }
    return {
      name,
      platform: this.platform,
      state: result.code === 0 ? "active" : exists ? "inactive" : "missing",
      configPaths: [path],
    };
  }
}
