import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "vite-plus/test";
import { defineJob, registerJobsInternal } from "../src/jobs";
import type { CronJob, CronOptions, NativeCronFunction } from "../src/types";

function recordingCron(calls: CronOptions[]): NativeCronFunction {
  const register = async (options: CronOptions): Promise<CronJob> => {
    calls.push(options);
    return {
      name: options.name,
      schedule: options.schedule,
      command: options.command,
      async start() {},
      async stop() {},
      async remove() {},
      async status() {
        return {
          name: options.name,
          platform: "darwin" as const,
          state: "active" as const,
          configPaths: [],
          schedule: options.schedule,
          command: options.command,
        };
      },
    };
  };

  return Object.assign(register, {
    get(): CronJob {
      throw new Error("not used");
    },
    async remove() {},
  });
}

test("defineJob validates and freezes a definition", () => {
  const definition = defineJob({
    name: "daily-sync",
    schedule: "0 6 * * *",
    async run() {},
  });

  assert.equal(Object.isFrozen(definition), true);
  assert.equal(definition.name, "daily-sync");
  assert.throws(
    () => defineJob({ name: "bad job", schedule: "@daily", async run() {} }),
    /job name/i,
  );
  assert.throws(
    () => defineJob({ name: "bad-schedule", schedule: "* *", async run() {} }),
    /expected 5 fields/,
  );
  assert.throws(
    () => defineJob({ name: "bad-run", schedule: "@daily", run: 42 as never }),
    /run must be a function/,
  );
});

test("registerJobs discovers TypeScript and JavaScript jobs and merges defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-cron-jobs-"));
  const jobs = join(root, "jobs");
  const nested = join(jobs, "nested");
  const calls: CronOptions[] = [];
  await mkdir(nested, { recursive: true });
  await Promise.all([
    writeFile(join(root, "package.json"), '{"type":"module"}\n'),
    writeFile(
      join(jobs, "cleanup.js"),
      `export default {
  name: "cleanup",
  schedule: "@hourly",
  env: { SHARED: "job", JOB_ONLY: "yes" },
  stdout: "cleanup.log",
  async run() {}
};
`,
    ),
    writeFile(
      join(jobs, "sync.ts"),
      `const name: string = "sync";
export default {
  name,
  schedule: "0 6 * * *",
  async run(): Promise<void> {}
};
`,
    ),
    writeFile(join(jobs, "ignored.d.ts"), "export interface Ignored {}\n"),
    writeFile(
      join(nested, "report.mjs"),
      'export default { name: "report", schedule: "@weekly", async run() {} };\n',
    ),
    writeFile(
      join(jobs, "commonjs.cjs"),
      'module.exports = { name: "commonjs", schedule: "@daily", async run() {} };\n',
    ),
  ]);

  try {
    const registered = await registerJobsInternal(
      new URL("./jobs/", new URL(`file://${root}/`)),
      {
        recursive: true,
        cwd: root,
        env: { SHARED: "default", DEFAULT_ONLY: "yes" },
        stderr: "errors.log",
      },
      { cron: recordingCron(calls) },
    );

    assert.deepEqual(
      registered.map(({ name }) => name),
      ["cleanup", "commonjs", "report", "sync"],
    );
    assert.equal(typeof registered[0].stop, "function");
    assert.equal(calls.length, 4);

    const cleanup = calls.find(({ name }) => name === "cleanup");
    const sync = calls.find(({ name }) => name === "sync");
    assert.deepEqual(cleanup?.env, {
      SHARED: "job",
      DEFAULT_ONLY: "yes",
      JOB_ONLY: "yes",
    });
    assert.equal(cleanup?.stdout, join(root, "cleanup.log"));
    assert.equal(cleanup?.stderr, join(root, "errors.log"));
    assert.deepEqual(cleanup?.command.slice(0, 1), [process.execPath]);
    assert.equal(cleanup?.command.includes("--experimental-strip-types"), false);
    assert.equal(basename(cleanup?.command.at(-2) ?? ""), "run-job.js");
    assert.equal(cleanup?.command.at(-1), join(jobs, "cleanup.js"));

    assert.equal(sync?.command.includes("--experimental-strip-types"), true);
    assert.equal(basename(sync?.command.at(-2) ?? ""), "run-job.js");
    assert.equal(sync?.command.at(-1), join(jobs, "sync.ts"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registerJobs rejects duplicate names before registering anything", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-cron-duplicates-"));
  const calls: CronOptions[] = [];
  await Promise.all([
    writeFile(join(root, "package.json"), '{"type":"module"}\n'),
    writeFile(
      join(root, "one.js"),
      'export default { name: "duplicate", schedule: "@daily", async run() {} };\n',
    ),
    writeFile(
      join(root, "two.mjs"),
      'export default { name: "DUPLICATE", schedule: "@hourly", async run() {} };\n',
    ),
  ]);

  try {
    await assert.rejects(
      registerJobsInternal(root, {}, { cron: recordingCron(calls) }),
      /Duplicate job name 'duplicate'/i,
    );
    assert.equal(calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registerJobs rejects an empty directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-cron-empty-"));
  try {
    await assert.rejects(
      registerJobsInternal(root, {}, { cron: recordingCron([]) }),
      /No TypeScript or JavaScript job files/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registerJobs validates convenience options", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-cron-options-"));
  try {
    await assert.rejects(
      registerJobsInternal(root, { recursive: "false" as never }, { cron: recordingCron([]) }),
      /recursive must be a boolean/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
