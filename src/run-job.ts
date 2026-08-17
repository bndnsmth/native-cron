import { runJob } from "./job-runner";

const path = process.argv[2];
if (!path) {
  console.error("Usage: native-cron runner <absolute-job-path>");
  process.exitCode = 1;
} else {
  const keepAlive = setInterval(() => {}, 2_147_483_647);
  void runJob(path).then(
    () => clearInterval(keepAlive),
    (error: unknown) => {
      clearInterval(keepAlive);
      console.error(error);
      process.exitCode = 1;
    },
  );
}
