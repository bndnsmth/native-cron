import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { createCronApi } from "../src/native-cron";
import { FakeRunner, SUCCESS } from "./helpers";

test("registers with the object API and returns a reusable lifecycle handle", async () => {
  const home = await mkdtemp(join(tmpdir(), "native-cron-api-"));
  const runner = new FakeRunner((command, args) => {
    if (command === "launchctl" && args[0] === "bootout") {
      return { code: 3, stdout: "", stderr: "Could not find service" };
    }
    return SUCCESS;
  });
  const cron = createCronApi({ platform: "darwin", home, uid: 501, runner });

  try {
    const job = await cron({
      name: "daily-sync",
      schedule: "0 6 * * *",
      command: [process.execPath, "sync.js"],
      cwd: home,
      env: { NODE_ENV: "production" },
    });

    assert.equal(job.name, "daily-sync");
    assert.equal(job.schedule, "0 6 * * *");
    assert.deepEqual(job.command, [process.execPath, "sync.js"]);
    assert.equal((await job.status()).state, "active");

    await cron.get("daily-sync").stop();
    await cron.remove("daily-sync");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("validates names, schedules, commands, environment, and working directories", async () => {
  const cron = createCronApi({ platform: "darwin", runner: new FakeRunner() });

  await assert.rejects(
    cron({ name: "../bad", schedule: "@daily", command: [process.execPath] }),
    /job name/,
  );
  await assert.rejects(
    cron({ name: "bad-schedule", schedule: "* * *", command: [process.execPath] }),
    /expected 5 fields/,
  );
  await assert.rejects(
    cron({ name: "bad-env", schedule: "@daily", command: [process.execPath], env: { "A-B": "x" } }),
    /environment variable name/,
  );
  await assert.rejects(
    cron({
      name: "bad-cwd",
      schedule: "@daily",
      command: [process.execPath],
      cwd: "/does/not/exist",
    }),
    /does not exist/,
  );
  assert.throws(() => cron.get(123 as never), /job name/);
});

test("normalizes login schedules to the reboot alias", async () => {
  const home = await mkdtemp(join(tmpdir(), "native-cron-login-api-"));
  const runner = new FakeRunner((command, args) => {
    if (command === "launchctl" && args[0] === "bootout") {
      return { code: 3, stdout: "", stderr: "Could not find service" };
    }
    return SUCCESS;
  });
  const cron = createCronApi({ platform: "darwin", home, uid: 501, runner });

  try {
    const job = await cron({
      name: "login-task",
      schedule: "@login",
      command: [process.execPath],
      cwd: home,
    });
    assert.equal(job.schedule, "@reboot");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
