import { homedir } from "node:os";
import { delimiter, isAbsolute, resolve, sep } from "node:path";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import type { ParsedCronExpression } from "./cron-expression";
import { parseCronExpression } from "./cron-expression";
import type { DriverContext, NativeCronDriver } from "./driver";
import { DarwinDriver } from "./drivers/darwin";
import { LinuxDriver } from "./drivers/linux";
import { WindowsDriver } from "./drivers/windows";
import { resolveFrom } from "./files";
import type { CommandRunner } from "./process";
import { defaultCommandRunner } from "./process";
import type {
  CronJob,
  CronOptions,
  JobStatus,
  NativeCronFunction,
  NativeCronPlatform,
  NormalizedCronOptions,
} from "./types";

const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface NativeCronRuntimeOptions {
  platform?: NativeCronPlatform;
  home?: string;
  uid?: number;
  xdgConfigHome?: string;
  localAppData?: string;
  userId?: string;
  runner?: CommandRunner;
}

export interface PreparedCronRegistration {
  readonly options: NormalizedCronOptions;
  readonly schedule: ParsedCronExpression;
}

function validateText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value || value.includes("\0") || /[\r\n]/u.test(value)) {
    throw new TypeError(`${label} must be a non-empty single-line string`);
  }
}

export function validateName(name: string): void {
  if (typeof name !== "string" || !NAME_PATTERN.test(name) || name.length > 100) {
    throw new TypeError(
      "Cron job name must be 1-100 characters containing only letters, numbers, hyphens, and underscores",
    );
  }
}

export async function normalizeOptions(options: CronOptions): Promise<{
  options: NormalizedCronOptions;
  schedule: ParsedCronExpression;
}> {
  if (!options || typeof options !== "object") {
    throw new TypeError("cron() requires an options object");
  }
  validateName(options.name);
  validateText(options.schedule, "Cron schedule");
  const schedule = parseCronExpression(options.schedule);

  if (!Array.isArray(options.command) || options.command.length === 0) {
    throw new TypeError("Cron command must be a non-empty array");
  }
  for (const [index, argument] of options.command.entries()) {
    validateText(argument, `Command argument ${index}`);
  }

  const cwd = resolve(options.cwd ?? process.cwd());
  const cwdStats = await stat(cwd).catch(() => undefined);
  if (!cwdStats?.isDirectory()) {
    throw new Error(`Cron working directory does not exist: ${cwd}`);
  }

  const executable = options.command[0];
  const pathLike =
    isAbsolute(executable) ||
    executable.startsWith(".") ||
    executable.includes(sep) ||
    executable.includes("/") ||
    executable.includes("\\");
  const executablePath = pathLike
    ? await validateExecutable(resolveFrom(cwd, executable))
    : await findExecutable(executable);
  const command = Object.freeze([executablePath, ...options.command.slice(1)]) as readonly [
    string,
    ...string[],
  ];

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (!ENVIRONMENT_NAME_PATTERN.test(key)) {
      throw new TypeError(`Invalid environment variable name: ${key}`);
    }
    validateText(value, `Environment variable ${key}`);
    env[key] = value;
  }

  for (const [label, value] of [
    ["stdout path", options.stdout],
    ["stderr path", options.stderr],
  ] as const) {
    if (value !== undefined) {
      validateText(value, label);
    }
  }

  return {
    options: Object.freeze({
      name: options.name,
      schedule: schedule.normalized,
      command,
      cwd,
      env: Object.freeze(env),
      stdout: options.stdout ? resolveFrom(cwd, options.stdout) : undefined,
      stderr: options.stderr ? resolveFrom(cwd, options.stderr) : undefined,
    }),
    schedule,
  };
}

async function findExecutable(command: string): Promise<string> {
  const path = process.env.PATH;
  if (!path) {
    throw new Error(
      `Cannot resolve '${command}' because PATH is empty; use an absolute executable path`,
    );
  }

  const pathExtensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";");
  const hasWindowsExtension = pathExtensions.some((extension) =>
    command.toLowerCase().endsWith(extension.toLowerCase()),
  );
  const extensions = process.platform === "win32" && !hasWindowsExtension ? pathExtensions : [""];
  for (const directory of path.split(delimiter)) {
    if (!directory) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = resolve(directory, `${command}${extension}`);
      try {
        return await validateExecutable(candidate);
      } catch {
        // Continue looking through PATH.
      }
    }
  }

  throw new Error(`Cannot resolve executable '${command}' from PATH; use an absolute path`);
}

async function validateExecutable(path: string): Promise<string> {
  const metadata = await stat(path).catch(() => undefined);
  if (!metadata?.isFile()) {
    throw new Error(`Cron executable does not exist: ${path}`);
  }
  if (process.platform !== "win32") {
    await access(path, constants.X_OK).catch((error) => {
      throw new Error(`Cron executable is not executable: ${path}`, { cause: error });
    });
  }
  return path;
}

function resolvePlatform(platform: NodeJS.Platform): NativeCronPlatform {
  if (platform === "darwin" || platform === "linux" || platform === "win32") {
    return platform;
  }
  throw new Error(`native-cron does not support ${platform}`);
}

function createDriver(runtime: NativeCronRuntimeOptions): NativeCronDriver {
  const platform = runtime.platform ?? resolvePlatform(process.platform);
  const configuredXdgHome = runtime.xdgConfigHome ?? process.env.XDG_CONFIG_HOME;
  const configuredLocalAppData = runtime.localAppData ?? process.env.LOCALAPPDATA;
  const username = process.env.USERNAME;
  const domain = process.env.USERDOMAIN;
  const context: DriverContext = {
    home: runtime.home ?? homedir(),
    uid: runtime.uid ?? (typeof process.getuid === "function" ? process.getuid() : -1),
    xdgConfigHome:
      configuredXdgHome && isAbsolute(configuredXdgHome) ? configuredXdgHome : undefined,
    localAppData:
      configuredLocalAppData && isAbsolute(configuredLocalAppData)
        ? configuredLocalAppData
        : undefined,
    userId:
      runtime.userId ?? (username ? (domain ? `${domain}\\${username}` : username) : undefined),
    runner: runtime.runner ?? defaultCommandRunner,
  };

  if (platform === "darwin") {
    return new DarwinDriver(context);
  }
  if (platform === "linux") {
    return new LinuxDriver(context);
  }
  return new WindowsDriver(context);
}

class NativeCronJob implements CronJob {
  readonly name: string;
  readonly schedule: string | undefined;
  readonly command: readonly string[] | undefined;
  readonly #driver: NativeCronDriver;

  constructor(
    driver: NativeCronDriver,
    name: string,
    schedule?: string,
    command?: readonly string[],
  ) {
    this.#driver = driver;
    this.name = name;
    this.schedule = schedule;
    this.command = command;
  }

  start(): Promise<void> {
    return this.#driver.start(this.name);
  }

  stop(): Promise<void> {
    return this.#driver.stop(this.name);
  }

  remove(): Promise<void> {
    return this.#driver.remove(this.name);
  }

  async status(): Promise<JobStatus> {
    const status = await this.#driver.status(this.name);
    return {
      ...status,
      schedule: this.schedule,
      command: this.command,
    };
  }
}

export function createCronApi(runtime: NativeCronRuntimeOptions = {}): NativeCronFunction {
  let driver: NativeCronDriver | undefined;
  const getDriver = (): NativeCronDriver => {
    driver ??= createDriver(runtime);
    return driver;
  };

  const register = async (options: CronOptions): Promise<CronJob> => {
    const driver = getDriver();
    const normalized = await normalizeOptions(options);
    await driver.register(normalized.options, normalized.schedule);
    return new NativeCronJob(
      driver,
      normalized.options.name,
      normalized.options.schedule,
      normalized.options.command,
    );
  };

  return Object.assign(register, {
    get(name: string): CronJob {
      validateName(name);
      return new NativeCronJob(getDriver(), name);
    },
    remove(name: string): Promise<void> {
      validateName(name);
      return getDriver().remove(name);
    },
  });
}

export async function preflightCronRegistrations(
  registrations: readonly PreparedCronRegistration[],
  runtime: NativeCronRuntimeOptions = {},
): Promise<void> {
  const driver = createDriver(runtime);
  for (const registration of registrations) {
    await driver.preflight(registration.options, registration.schedule);
  }
}
