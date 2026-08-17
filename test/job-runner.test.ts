import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { runJob } from "../src/job-runner";

test("runJob executes default run functions from JavaScript and TypeScript modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-cron-runner-"));
  const output = join(root, "output.txt");
  const jsPath = join(root, "javascript.mjs");
  const tsPath = join(root, "typescript.ts");
  await Promise.all([
    writeFile(
      jsPath,
      `import { appendFile } from "node:fs/promises";
export default { async run() { await appendFile(${JSON.stringify(output)}, "js\\n"); } };
`,
    ),
    writeFile(
      tsPath,
      `import { appendFile } from "node:fs/promises";
const value: string = "ts\\n";
export default { async run(): Promise<void> { await appendFile(${JSON.stringify(output)}, value); } };
`,
    ),
  ]);

  try {
    await runJob(jsPath);
    await runJob(tsPath);
    assert.equal(await readFile(output, "utf8"), "js\nts\n");
    await assert.rejects(runJob("relative.js"), /must be absolute/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runJob requires a default export with run", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-cron-runner-invalid-"));
  const path = join(root, "invalid.mjs");
  await writeFile(path, "export default { name: 'missing-run' };\n");

  try {
    await assert.rejects(runJob(path), /must define run/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
