import { readdir, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseCronExpression } from "./cron-expression";
import {
  createCronApi,
  normalizeOptions,
  preflightCronRegistrations,
  validateName,
} from "./native-cron";
import type { NativeCronRuntimeOptions } from "./native-cron";
import type { CronJob, CronOptions, NativeCronFunction } from "./types";

const JOB_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);
const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".mts", ".cts"]);
const RUNNER_PATH = fileURLToPath(new URL("./run-job.js", import.meta.url));

export type JobRun = () => void | Promise<void>;

export interface JobDefinition extends Omit<CronOptions, "command" | "name" | "schedule"> {
  name: string;
  schedule: string;
  run: JobRun;
}

export interface RegisterJobsOptions extends Omit<CronOptions, "command" | "name" | "schedule"> {
  recursive?: boolean;
}

export interface RegisteredJob extends CronJob {
  readonly definition: Readonly<JobDefinition>;
  readonly path: string;
  readonly schedule: string;
  readonly command: readonly string[];
}

export interface RegisterJobsRuntimeOptions {
  cron?: NativeCronFunction;
  nativeCron?: NativeCronRuntimeOptions;
}

interface LoadedJob {
  definition: Readonly<JobDefinition>;
  path: string;
}

function validateOptionalString(value: unknown, label: string): void {
  if (
    value !== undefined &&
    (typeof value !== "string" || !value || value.includes("\0") || /[\r\n]/u.test(value))
  ) {
    throw new TypeError(`${label} must be a non-empty single-line string`);
  }
}

function validateEnvironment(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Job env must be an object of string values");
  }
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof item !== "string") {
      throw new TypeError("Job env must contain valid environment names and string values");
    }
    validateOptionalString(item, `Environment variable ${key}`);
  }
}

function validateDefinition(value: unknown, source = "Job definition"): JobDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${source} must be an object`);
  }
  const candidate = value as Partial<JobDefinition>;
  validateName(candidate.name as string);
  parseCronExpression(candidate.schedule as string);
  if (typeof candidate.run !== "function") {
    throw new TypeError(`${source} run must be a function`);
  }
  validateOptionalString(candidate.cwd, "Job cwd");
  validateOptionalString(candidate.stdout, "Job stdout");
  validateOptionalString(candidate.stderr, "Job stderr");
  validateEnvironment(candidate.env);
  return candidate as JobDefinition;
}

export function defineJob<const Definition extends JobDefinition>(
  definition: Definition,
): Readonly<Definition> {
  validateDefinition(definition);
  return Object.freeze(definition);
}

function resolveDirectory(directory: string | URL): string {
  if (directory instanceof URL) {
    if (directory.protocol !== "file:") {
      throw new TypeError("Jobs directory URL must use the file: protocol");
    }
    return fileURLToPath(directory);
  }
  if (typeof directory !== "string" || !directory) {
    throw new TypeError("Jobs directory must be a non-empty path or file URL");
  }
  return resolve(directory);
}

async function discoverJobFiles(directory: string, recursive: boolean): Promise<readonly string[]> {
  const metadata = await stat(directory).catch(() => undefined);
  if (!metadata?.isDirectory()) {
    throw new Error(`Jobs directory does not exist: ${directory}`);
  }

  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory() && recursive) {
      files.push(...(await discoverJobFiles(path, true)));
    } else if (
      entry.isFile() &&
      !/\.d\.(?:ts|mts|cts)$/iu.test(entry.name) &&
      JOB_EXTENSIONS.has(extname(entry.name))
    ) {
      files.push(path);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function hasTypeStripping(): boolean {
  const feature = (process.features as { typescript?: string }).typescript;
  if (feature === "strip") {
    return true;
  }
  if (feature !== undefined) {
    return false;
  }
  if (process.execArgv.includes("--experimental-strip-types")) {
    return true;
  }
  const nodeOptions = process.env.NODE_OPTIONS?.split(/\s+/u) ?? [];
  if (nodeOptions.includes("--experimental-strip-types")) {
    return true;
  }
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
}

function validateTypeScriptSupport(files: readonly string[]): void {
  if (
    files.some((path) => TYPESCRIPT_EXTENSIONS.has(extname(path).toLowerCase())) &&
    !hasTypeStripping()
  ) {
    throw new Error(
      "TypeScript jobs require Node.js 22.6 or newer with native type stripping; use JavaScript jobs or upgrade Node.js",
    );
  }
}

async function loadJobs(files: readonly string[]): Promise<readonly LoadedJob[]> {
  const jobs = await Promise.all(
    files.map(async (path) => {
      let module: Record<string, unknown>;
      try {
        module = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
      } catch (error) {
        throw new Error(`Unable to import job module ${path}`, { cause: error });
      }
      const definition = Object.freeze(
        validateDefinition(module.default, `Default export from ${path}`),
      );
      return { definition, path };
    }),
  );

  const names = new Map<string, string>();
  for (const job of jobs) {
    const key = job.definition.name.toLowerCase();
    const duplicate = names.get(key);
    if (duplicate) {
      throw new Error(
        `Duplicate job name '${job.definition.name}' in ${duplicate} and ${job.path}`,
      );
    }
    names.set(key, job.path);
  }
  return jobs;
}

function mergeOptions(
  defaults: RegisterJobsOptions,
  definition: Readonly<JobDefinition>,
  path: string,
): CronOptions {
  const env = { ...defaults.env, ...definition.env };
  const stripTypes = TYPESCRIPT_EXTENSIONS.has(extname(path).toLowerCase());
  return {
    name: definition.name,
    schedule: definition.schedule,
    command: [
      process.execPath,
      ...(stripTypes ? ["--experimental-strip-types"] : []),
      RUNNER_PATH,
      path,
    ],
    cwd: definition.cwd ?? defaults.cwd,
    env: Object.keys(env).length > 0 ? env : undefined,
    stdout: definition.stdout ?? defaults.stdout,
    stderr: definition.stderr ?? defaults.stderr,
  };
}

export async function registerJobs(
  directory: string | URL,
  options: RegisterJobsOptions = {},
): Promise<readonly RegisteredJob[]> {
  return registerJobsInternal(directory, options);
}

export async function registerJobsInternal(
  directory: string | URL,
  options: RegisterJobsOptions = {},
  runtime: RegisterJobsRuntimeOptions = {},
): Promise<readonly RegisteredJob[]> {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("registerJobs options must be an object");
  }
  if (options.recursive !== undefined && typeof options.recursive !== "boolean") {
    throw new TypeError("registerJobs recursive must be a boolean");
  }
  const root = resolveDirectory(directory);
  const files = await discoverJobFiles(root, options.recursive ?? false);
  if (files.length === 0) {
    throw new Error(`No TypeScript or JavaScript job files found in ${root}`);
  }
  validateTypeScriptSupport(files);
  const loaded = await loadJobs(files);
  const cron = runtime.cron ?? createCronApi(runtime.nativeCron);

  // Normalize every registration first so one invalid definition cannot create a partial set.
  const registrations = await Promise.all(
    loaded.map(async ({ definition, path }) => {
      const normalized = await normalizeOptions(mergeOptions(options, definition, path));
      return {
        definition,
        path,
        options: normalized.options,
        parsedSchedule: normalized.schedule,
      };
    }),
  );
  if (!runtime.cron) {
    await preflightCronRegistrations(
      registrations.map(({ options: cronOptions, parsedSchedule }) => ({
        options: cronOptions,
        schedule: parsedSchedule,
      })),
      runtime.nativeCron,
    );
  }

  const registered: RegisteredJob[] = [];
  for (const registration of registrations) {
    const job = await cron(registration.options);
    registered.push(
      Object.freeze(
        Object.assign(job, {
          definition: registration.definition,
          path: registration.path,
        }) as RegisteredJob,
      ),
    );
  }
  return Object.freeze(registered);
}
