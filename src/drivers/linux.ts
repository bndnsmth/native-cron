import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ParsedCalendarCronExpression, ParsedCronExpression } from "../cron-expression";
import type { DriverContext, NativeCronDriver } from "../driver";
import { systemdExecQuote, systemdQuote } from "../escape";
import { atomicWrite, ensureOutputDirectory, pathExists } from "../files";
import { NativeCommandError, runChecked } from "../process";
import type { JobStatus, NormalizedCronOptions } from "../types";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function list(values: readonly number[], wildcard: boolean): string {
  return wildcard ? "*" : values.join(",");
}

function calendarLines(schedule: ParsedCalendarCronExpression): readonly string[] {
  const month = list(schedule.month.values, schedule.month.wildcard);
  const day = list(schedule.dayOfMonth.values, schedule.dayOfMonth.wildcard);
  const hour = list(schedule.hour.values, schedule.hour.wildcard);
  const minute = list(schedule.minute.values, schedule.minute.wildcard);
  const time = `${hour}:${minute}:00`;
  const weekdays = schedule.dayOfWeek.values.map((value) => WEEKDAYS[value]).join(",");

  if (!schedule.dayOfMonth.wildcard && !schedule.dayOfWeek.wildcard) {
    return [`*-${month}-${day} ${time}`, `${weekdays} *-${month}-* ${time}`];
  }
  if (!schedule.dayOfWeek.wildcard) {
    return [`${weekdays} *-${month}-* ${time}`];
  }
  return [`*-${month}-${day} ${time}`];
}

export function renderSystemdService(
  options: NormalizedCronOptions,
  schedule: ParsedCronExpression,
): string {
  const environment = Object.entries(options.env)
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
    .join("\n");
  const stdout = options.stdout
    ? `\nStandardOutput=${systemdQuote(`append:${options.stdout}`)}`
    : "";
  const stderr = options.stderr
    ? `\nStandardError=${systemdQuote(`append:${options.stderr}`)}`
    : "";

  const startup =
    schedule.trigger === "startup"
      ? "\nRemainAfterExit=true\n\n[Install]\nWantedBy=default.target"
      : "";

  return `[Unit]
Description=native-cron job: ${options.name}

[Service]
Type=oneshot
WorkingDirectory=${systemdQuote(options.cwd)}
ExecStart=${options.command.map(systemdExecQuote).join(" ")}${environment ? `\n${environment}` : ""}${stdout}${stderr}${startup}
`;
}

export function renderSystemdTimer(
  options: NormalizedCronOptions,
  schedule: ParsedCalendarCronExpression,
): string {
  const calendars = calendarLines(schedule)
    .map((value) => `OnCalendar=${value}`)
    .join("\n");
  return `[Unit]
Description=native-cron schedule: ${options.name}

[Timer]
${calendars}
Persistent=true
AccuracySec=1s
Unit=native-cron-${options.name}.service

[Install]
WantedBy=timers.target
`;
}

export class LinuxDriver implements NativeCronDriver {
  readonly platform = "linux" as const;
  readonly #context: DriverContext;

  constructor(context: DriverContext) {
    this.#context = context;
  }

  #paths(name: string): readonly [string, string] {
    const configRoot = this.#context.xdgConfigHome ?? join(this.#context.home, ".config");
    const root = join(configRoot, "systemd", "user");
    return [join(root, `native-cron-${name}.service`), join(root, `native-cron-${name}.timer`)];
  }

  #timer(name: string): string {
    return `native-cron-${name}.timer`;
  }

  async preflight(options: NormalizedCronOptions, schedule: ParsedCronExpression): Promise<void> {
    renderSystemdService(options, schedule);
    if (schedule.trigger === "calendar") {
      renderSystemdTimer(options, schedule);
    }
  }

  async #installedUnit(name: string): Promise<string | undefined> {
    const [servicePath, timerPath] = this.#paths(name);
    if (await pathExists(timerPath)) {
      return this.#timer(name);
    }
    return (await pathExists(servicePath)) ? `native-cron-${name}.service` : undefined;
  }

  async #disable(unit: string): Promise<void> {
    await runChecked(this.#context.runner, "systemctl", ["--user", "disable", "--now", unit]);
  }

  async register(options: NormalizedCronOptions, schedule: ParsedCronExpression): Promise<void> {
    await this.preflight(options, schedule);
    await Promise.all([
      ensureOutputDirectory(options.stdout),
      ensureOutputDirectory(options.stderr),
    ]);
    const [servicePath, timerPath] = this.#paths(options.name);
    const installedUnit = await this.#installedUnit(options.name);
    if (installedUnit) {
      await this.#disable(installedUnit);
    }
    await atomicWrite(servicePath, renderSystemdService(options, schedule));
    if (schedule.trigger === "startup") {
      await rm(timerPath, { force: true });
    } else {
      await atomicWrite(timerPath, renderSystemdTimer(options, schedule));
    }
    await runChecked(this.#context.runner, "systemctl", ["--user", "daemon-reload"]);
    const unit =
      schedule.trigger === "startup"
        ? `native-cron-${options.name}.service`
        : this.#timer(options.name);
    if (schedule.trigger === "startup") {
      await runChecked(this.#context.runner, "systemctl", ["--user", "enable", unit]);
      await runChecked(this.#context.runner, "systemctl", ["--user", "start", "--no-block", unit]);
    } else {
      await runChecked(this.#context.runner, "systemctl", ["--user", "enable", unit]);
      await runChecked(this.#context.runner, "systemctl", ["--user", "restart", unit]);
    }
  }

  async start(name: string): Promise<void> {
    const unit = await this.#installedUnit(name);
    if (!unit) {
      throw new Error(`Cron job '${name}' is not registered`);
    }
    if (unit.endsWith(".service")) {
      await runChecked(this.#context.runner, "systemctl", ["--user", "enable", unit]);
      await runChecked(this.#context.runner, "systemctl", ["--user", "start", "--no-block", unit]);
    } else {
      await runChecked(this.#context.runner, "systemctl", ["--user", "enable", "--now", unit]);
    }
  }

  async stop(name: string): Promise<void> {
    const unit = await this.#installedUnit(name);
    if (!unit) {
      return;
    }
    await this.#disable(unit);
  }

  async remove(name: string): Promise<void> {
    const paths = this.#paths(name);
    await this.stop(name);
    await Promise.all(paths.map((path) => rm(path, { force: true })));
    await runChecked(this.#context.runner, "systemctl", ["--user", "daemon-reload"]);
  }

  async status(name: string): Promise<JobStatus> {
    const paths = this.#paths(name);
    const exists = await Promise.all(paths.map(pathExists));
    const unit = exists[1] ? this.#timer(name) : `native-cron-${name}.service`;
    const result = await this.#context.runner.run("systemctl", [
      "--user",
      "is-active",
      "--quiet",
      unit,
    ]);
    if (result.code !== 0 && result.code !== 3 && result.code !== 4) {
      throw new NativeCommandError(`systemctl --user is-active ${unit}`, result);
    }
    return {
      name,
      platform: this.platform,
      state: result.code === 0 ? "active" : exists.some(Boolean) ? "inactive" : "missing",
      configPaths: paths,
    };
  }
}
