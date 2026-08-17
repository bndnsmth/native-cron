import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ParsedCalendarCronExpression, ParsedCronExpression } from "../cron-expression";
import type { DriverContext, NativeCronDriver } from "../driver";
import { powershellQuote, windowsArgument, xmlEscape } from "../escape";
import { atomicWrite, ensureOutputDirectory, pathExists } from "../files";
import { runChecked } from "../process";
import type { JobStatus, NormalizedCronOptions } from "../types";

const MONTHS = [
  "",
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

function utf16le(value: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(value, "utf16le")]);
}

function taskIsMissing(code: number): boolean {
  return code === 0x80070002 || code === -2147024894;
}

function evenlySpaced(values: readonly number[], period: number): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  if (values.length === 1) {
    return period;
  }
  const step = values[1] - values[0];
  if (step <= 0 || period % step !== 0 || values.length !== period / step) {
    return undefined;
  }
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] !== values[0] + index * step) {
      return undefined;
    }
  }
  return step;
}

function startBoundary(hour: number, minute: number): string {
  return `2000-01-01T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
}

function valuesXml(wrapper: string, element: string, values: readonly (string | number)[]): string {
  return `<${wrapper}>${values.map((value) => `<${element}>${value}</${element}>`).join("")}</${wrapper}>`;
}

function namedValuesXml(wrapper: string, values: readonly string[]): string {
  return `<${wrapper}>${values.map((value) => `<${value}/>`).join("")}</${wrapper}>`;
}

function calendarTrigger(boundary: string, scheduleXml: string, repetition?: string): string {
  return `    <CalendarTrigger>
      <StartBoundary>${boundary}</StartBoundary>${repetition ? `\n      <Repetition><Interval>${repetition}</Interval></Repetition>` : ""}
      ${scheduleXml}
    </CalendarTrigger>`;
}

function monthlySchedule(schedule: ParsedCalendarCronExpression): string {
  return `<ScheduleByMonth>${valuesXml("DaysOfMonth", "Day", schedule.dayOfMonth.values)}${namedValuesXml(
    "Months",
    schedule.month.values.map((value) => MONTHS[value]),
  )}</ScheduleByMonth>`;
}

function weekdaySchedule(schedule: ParsedCalendarCronExpression): string {
  const days = namedValuesXml(
    "DaysOfWeek",
    schedule.dayOfWeek.values.map((value) => WEEKDAYS[value]),
  );
  if (schedule.month.wildcard) {
    return `<ScheduleByWeek><WeeksInterval>1</WeeksInterval>${days}</ScheduleByWeek>`;
  }
  return `<ScheduleByMonthDayOfWeek><Weeks><Week>1</Week><Week>2</Week><Week>3</Week><Week>4</Week><Week>Last</Week></Weeks>${days}${namedValuesXml(
    "Months",
    schedule.month.values.map((value) => MONTHS[value]),
  )}</ScheduleByMonthDayOfWeek>`;
}

function anyDaySchedule(schedule: ParsedCalendarCronExpression): string {
  if (schedule.month.wildcard) {
    return "<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>";
  }
  return `<ScheduleByMonth>${valuesXml(
    "DaysOfMonth",
    "Day",
    Array.from({ length: 31 }, (_, index) => index + 1),
  )}${namedValuesXml(
    "Months",
    schedule.month.values.map((value) => MONTHS[value]),
  )}</ScheduleByMonth>`;
}

function renderTriggers(schedule: ParsedCalendarCronExpression): string {
  const datesWildcard =
    schedule.dayOfMonth.wildcard && schedule.dayOfWeek.wildcard && schedule.month.wildcard;
  const minuteStep = evenlySpaced(schedule.minute.values, 60);
  const hourStep = evenlySpaced(schedule.hour.values, 24);
  const minuteRepetition =
    datesWildcard && schedule.hour.wildcard && minuteStep !== undefined && 60 % minuteStep === 0;
  const hourRepetition =
    datesWildcard &&
    schedule.minute.values.length === 1 &&
    hourStep !== undefined &&
    24 % hourStep === 0;

  if (minuteRepetition || hourRepetition) {
    const interval = minuteRepetition ? `PT${minuteStep}M` : `PT${hourStep}H`;
    return calendarTrigger(
      startBoundary(schedule.hour.values[0], schedule.minute.values[0]),
      anyDaySchedule(schedule),
      interval,
    );
  }

  const orSplit = !schedule.dayOfMonth.wildcard && !schedule.dayOfWeek.wildcard;
  const count = schedule.hour.values.length * schedule.minute.values.length * (orSplit ? 2 : 1);
  if (count > 48) {
    throw new Error(
      `Cron expression requires ${count} Windows Task Scheduler triggers; the platform limit is 48`,
    );
  }

  const triggers: string[] = [];
  for (const hour of schedule.hour.values) {
    for (const minute of schedule.minute.values) {
      const boundary = startBoundary(hour, minute);
      if (!schedule.dayOfMonth.wildcard) {
        triggers.push(calendarTrigger(boundary, monthlySchedule(schedule)));
      }
      if (!schedule.dayOfWeek.wildcard) {
        triggers.push(calendarTrigger(boundary, weekdaySchedule(schedule)));
      }
      if (schedule.dayOfMonth.wildcard && schedule.dayOfWeek.wildcard) {
        triggers.push(calendarTrigger(boundary, anyDaySchedule(schedule)));
      }
    }
  }
  return triggers.join("\n");
}

export function renderPowerShellWrapper(options: NormalizedCronOptions): string {
  const environment = Object.entries(options.env)
    .map(([key, value]) => `$env:${key} = ${powershellQuote(value)}`)
    .join("\n");
  const command = options.command.map(powershellQuote).join(" ");
  const stdout = options.stdout ? ` 1>> ${powershellQuote(options.stdout)}` : "";
  const stderr = options.stderr ? ` 2>> ${powershellQuote(options.stderr)}` : "";

  return `$ErrorActionPreference = 'Stop'
${environment ? `${environment}\n` : ""}Set-Location -LiteralPath ${powershellQuote(options.cwd)}
& ${command}${stdout}${stderr}
$nativeCronExitCode = $LASTEXITCODE
if ($null -eq $nativeCronExitCode) { $nativeCronExitCode = 0 }
exit $nativeCronExitCode
`;
}

export function renderTaskXml(
  options: NormalizedCronOptions,
  schedule: ParsedCronExpression,
  scriptPath: string,
  userId?: string,
): string {
  const argumentsValue = [
    "-NoLogo",
    "-NonInteractive",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
  ]
    .map(windowsArgument)
    .join(" ");
  if (!userId) {
    throw new Error("Cannot register a Windows job without the current user identity");
  }
  const triggers =
    schedule.trigger === "startup"
      ? `    <LogonTrigger><Enabled>true</Enabled><UserId>${xmlEscape(userId!)}</UserId></LogonTrigger>`
      : renderTriggers(schedule);

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>native-cron job: ${xmlEscape(options.name)}</Description></RegistrationInfo>
  <Triggers>
${triggers}
  </Triggers>
  <Principals><Principal><UserId>${xmlEscape(userId)}</UserId><LogonType>S4U</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <Enabled>true</Enabled>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <AllowHardTerminate>true</AllowHardTerminate>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>true</StartWhenAvailable>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions><Exec><Command>powershell.exe</Command><Arguments>${xmlEscape(argumentsValue)}</Arguments><WorkingDirectory>${xmlEscape(options.cwd)}</WorkingDirectory></Exec></Actions>
</Task>
`;
}

export class WindowsDriver implements NativeCronDriver {
  readonly platform = "win32" as const;
  readonly #context: DriverContext;
  readonly #root: string;

  constructor(
    context: DriverContext,
    root = join(context.localAppData ?? join(context.home, "AppData", "Local"), "native-cron"),
  ) {
    this.#context = context;
    this.#root = root;
  }

  #paths(name: string): readonly [string, string] {
    return [join(this.#root, `${name}.xml`), join(this.#root, `${name}.ps1`)];
  }

  #task(name: string): string {
    return `native-cron-${name}`;
  }

  async #isStartup(name: string): Promise<boolean> {
    const [xmlPath] = this.#paths(name);
    const xml = await readFile(xmlPath, "utf16le").catch(() => "");
    return xml.includes("<LogonTrigger>");
  }

  async preflight(options: NormalizedCronOptions, schedule: ParsedCronExpression): Promise<void> {
    const [, scriptPath] = this.#paths(options.name);
    renderPowerShellWrapper(options);
    renderTaskXml(options, schedule, scriptPath, this.#context.userId);
  }

  async register(options: NormalizedCronOptions, schedule: ParsedCronExpression): Promise<void> {
    await this.preflight(options, schedule);
    await Promise.all([
      ensureOutputDirectory(options.stdout),
      ensureOutputDirectory(options.stderr),
    ]);
    const [xmlPath, scriptPath] = this.#paths(options.name);
    const paths = [xmlPath, scriptPath] as const;
    const previousFiles = await Promise.all(
      paths.map(async (path) => ((await pathExists(path)) ? readFile(path) : undefined)),
    );
    try {
      await atomicWrite(scriptPath, utf16le(renderPowerShellWrapper(options)));
      await atomicWrite(
        xmlPath,
        utf16le(renderTaskXml(options, schedule, scriptPath, this.#context.userId)),
      );
      await runChecked(this.#context.runner, "schtasks.exe", [
        "/create",
        "/xml",
        xmlPath,
        "/tn",
        this.#task(options.name),
        "/np",
        "/f",
      ]);
    } catch (cause) {
      await Promise.all(
        paths.map((path, index) => {
          const previous = previousFiles[index];
          return previous ? atomicWrite(path, previous) : rm(path, { force: true });
        }),
      );
      throw cause;
    }
    if (schedule.trigger === "startup") {
      await runChecked(this.#context.runner, "schtasks.exe", [
        "/run",
        "/tn",
        this.#task(options.name),
      ]);
    }
  }

  async start(name: string): Promise<void> {
    if ((await this.status(name)).state === "missing") {
      throw new Error(`Cron job '${name}' is not registered`);
    }
    await runChecked(this.#context.runner, "schtasks.exe", [
      "/change",
      "/tn",
      this.#task(name),
      "/enable",
    ]);
    if (await this.#isStartup(name)) {
      await runChecked(this.#context.runner, "schtasks.exe", ["/run", "/tn", this.#task(name)]);
    }
  }

  async stop(name: string): Promise<void> {
    if ((await this.status(name)).state !== "missing") {
      await runChecked(this.#context.runner, "schtasks.exe", [
        "/change",
        "/tn",
        this.#task(name),
        "/disable",
      ]);
    }
  }

  async remove(name: string): Promise<void> {
    const paths = this.#paths(name);
    if ((await this.status(name)).state !== "missing") {
      await runChecked(this.#context.runner, "schtasks.exe", [
        "/delete",
        "/tn",
        this.#task(name),
        "/f",
      ]);
    }
    await Promise.all(paths.map((path) => rm(path, { force: true })));
  }

  async status(name: string): Promise<JobStatus> {
    const paths = this.#paths(name);
    const result = await this.#context.runner.run("schtasks.exe", [
      "/query",
      "/tn",
      this.#task(name),
      "/xml",
      "/hresult",
    ]);
    if (result.code !== 0) {
      if (!taskIsMissing(result.code)) {
        throw new Error(`Unable to query cron job '${name}': ${result.stderr.trim()}`);
      }
      return {
        name,
        platform: this.platform,
        state: "missing",
        configPaths: paths,
      };
    }
    return {
      name,
      platform: this.platform,
      state: /<Enabled>\s*false\s*<\/Enabled>/i.test(result.stdout) ? "inactive" : "active",
      configPaths: paths,
    };
  }
}
