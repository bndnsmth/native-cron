import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { parseCronExpression } from "../src/cron-expression";
import { DarwinDriver, renderLaunchdPlist } from "../src/drivers/darwin";
import type { NormalizedCronOptions } from "../src/types";
import { FakeRunner, SUCCESS } from "./helpers";

const OPTIONS: NormalizedCronOptions = {
  name: "backup",
  schedule: "0 2 15 * 5",
  command: ["/usr/local/bin/node", "/Users/me/My App/backup.js", "a&b"],
  cwd: "/Users/me/My App",
  env: { NODE_ENV: "production", TOKEN: "a&<b" },
  stdout: "/Users/me/.logs/backup.log",
  stderr: "/Users/me/.logs/backup.err.log",
};

test("renders a launchd plist with safe native arguments and POSIX OR semantics", () => {
  const plist = renderLaunchdPlist(OPTIONS, parseCronExpression(OPTIONS.schedule));

  assert.match(plist, /<string>\/Users\/me\/My App\/backup\.js<\/string>/);
  assert.match(plist, /<string>a&amp;b<\/string>/);
  assert.match(plist, /<string>a&amp;&lt;b<\/string>/);
  assert.equal((plist.match(/<dict>/g) ?? []).length, 4);
  assert.match(plist, /<key>Day<\/key>\s*<integer>15<\/integer>/);
  assert.match(plist, /<key>Weekday<\/key>\s*<integer>5<\/integer>/);
});

test("renders startup schedules as launchd RunAtLoad jobs", () => {
  const plist = renderLaunchdPlist(
    { ...OPTIONS, schedule: "@reboot" },
    parseCronExpression("@login"),
  );

  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.doesNotMatch(plist, /StartCalendarInterval/);
});

test("registers, replaces, stops, starts, reports, and removes a launchd job", async () => {
  const home = await mkdtemp(join(tmpdir(), "native-cron-darwin-"));
  const runner = new FakeRunner((command, args) => {
    if (command === "launchctl" && args[0] === "bootout") {
      return { code: 3, stdout: "", stderr: "Dienst nicht gefunden" };
    }
    if (command === "launchctl" && args[0] === "print") {
      return { code: 113, stdout: "", stderr: "Could not find service" };
    }
    return SUCCESS;
  });
  const driver = new DarwinDriver({ home, uid: 501, runner });
  const options = { ...OPTIONS, cwd: home, stdout: undefined, stderr: undefined };

  try {
    await driver.register(options, parseCronExpression(options.schedule));
    const status = await driver.status(options.name);
    assert.equal(status.state, "inactive");
    assert.match(await readFile(status.configPaths[0], "utf8"), /native-cron\.backup/);

    await driver.start(options.name);
    await driver.stop(options.name);
    await driver.remove(options.name);
    assert.equal((await driver.status(options.name)).state, "missing");
    assert.ok(runner.commands.some(({ args }) => args[0] === "bootstrap"));
    assert.ok(runner.commands.some(({ args }) => args[0] === "disable"));
    assert.ok(runner.commands.some(({ args }) => args[0] === "enable"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
