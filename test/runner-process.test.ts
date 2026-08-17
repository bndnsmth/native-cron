import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";

function spawnRunner(
  runner: string,
  job: string,
): { child: ReturnType<typeof spawn>; exit: Promise<number> } {
  const child = spawn(process.execPath, [runner, job], { stdio: "ignore" });
  const exit = new Promise<number>((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("exit", (code) => resolvePromise(code ?? 1));
  });
  return { child, exit };
}

test("packaged runner remains alive until the job promise settles", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-cron-runner-process-"));
  const job = join(root, "pending.mjs");
  const runner = join(import.meta.dirname, "..", "dist", "run-job.js");
  await writeFile(job, "export default { run() { return new Promise(() => {}); } };\n");

  try {
    const process = spawnRunner(runner, job);
    const outcome = await Promise.race([
      process.exit.then((code) => `exit:${code}`),
      new Promise<string>((resolvePromise) => setTimeout(() => resolvePromise("running"), 150)),
    ]);
    assert.equal(outcome, "running");
    process.child.kill();
    await process.exit;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packaged runner exits nonzero when a job rejects", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-cron-runner-reject-"));
  const job = join(root, "reject.mjs");
  const runner = join(import.meta.dirname, "..", "dist", "run-job.js");
  await writeFile(job, "export default { async run() { throw new Error('failed'); } };\n");

  try {
    assert.equal(await spawnRunner(runner, job).exit, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
