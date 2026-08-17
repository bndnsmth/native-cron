import { createCronApi } from "./native-cron";
import type { NativeCronFunction } from "./types";

export { parseCronExpression } from "./cron-expression";
export type {
  CronField,
  ParsedCalendarCronExpression,
  ParsedCronExpression,
  ParsedStartupCronExpression,
} from "./cron-expression";
export { defineJob, registerJobs } from "./jobs";
export type { JobDefinition, JobRun, RegisteredJob, RegisterJobsOptions } from "./jobs";
export type {
  CronJob,
  CronOptions,
  JobStatus,
  NativeCronFunction,
  NativeCronPlatform,
} from "./types";

export const cron: NativeCronFunction = createCronApi();

export const getJob: NativeCronFunction["get"] = (name) => cron.get(name);
export const removeJob: NativeCronFunction["remove"] = (name) => cron.remove(name);
