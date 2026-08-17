import type { ParsedCronExpression } from "./cron-expression";
import type { CommandRunner } from "./process";
import type { JobStatus, NativeCronPlatform, NormalizedCronOptions } from "./types";

export interface DriverContext {
  home: string;
  uid: number;
  xdgConfigHome?: string;
  localAppData?: string;
  userId?: string;
  runner: CommandRunner;
}

export interface NativeCronDriver {
  readonly platform: NativeCronPlatform;
  preflight(options: NormalizedCronOptions, schedule: ParsedCronExpression): Promise<void>;
  register(options: NormalizedCronOptions, schedule: ParsedCronExpression): Promise<void>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  status(name: string): Promise<JobStatus>;
}
