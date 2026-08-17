export type NativeCronPlatform = "darwin" | "linux" | "win32";

export interface CronOptions {
  name: string;
  schedule: string;
  command: readonly [string, ...string[]];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  stdout?: string;
  stderr?: string;
}

export interface JobStatus {
  name: string;
  platform: NativeCronPlatform;
  state: "active" | "inactive" | "missing";
  configPaths: readonly string[];
  schedule?: string;
  command?: readonly string[];
}

export interface CronJob {
  readonly name: string;
  readonly schedule: string | undefined;
  readonly command: readonly string[] | undefined;
  start(): Promise<void>;
  stop(): Promise<void>;
  remove(): Promise<void>;
  status(): Promise<JobStatus>;
}

export interface NativeCronFunction {
  (options: CronOptions): Promise<CronJob>;
  get(name: string): CronJob;
  remove(name: string): Promise<void>;
}

export interface NormalizedCronOptions {
  name: string;
  schedule: string;
  command: readonly [string, ...string[]];
  cwd: string;
  env: Readonly<Record<string, string>>;
  stdout?: string;
  stderr?: string;
}
