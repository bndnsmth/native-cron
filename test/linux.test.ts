import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { parseCronExpression } from "../src/cron-expression";
import { LinuxDriver, renderSystemdService, renderSystemdTimer } from "../src/drivers/linux";
import { createCronApi } from "../src/native-cron";
import type { NormalizedCronOptions } from "../src/types";
import { FakeRunner, SUCCESS } from "./helpers";

const OPTIONS: NormalizedCronOptions = {
  name: "daily-sync",
  schedule: "0 6 15 * 1",
  command: ["/usr/bin/node", "/home/me/app/sync.js", "100%", "has space"],
  cwd: "/home/me/app",
  env: { NODE_ENV: "production", VALUE: "a$b%" },
  stdout: "/home/me/.logs/out.log",
  stderr: "/home/me/.logs/err.log",
};

test("renders safe systemd service and timer units", () => {
  const schedule = parseCronExpression(OPTIONS.schedule);
  assert.equal(schedule.trigger, "calendar");
  if (schedule.trigger !== "calendar") {
    assert.fail("expected a calendar schedule");
  }
  const service = renderSystemdService(OPTIONS, schedule);
  const timer = renderSystemdTimer(OPTIONS, schedule);

  assert.match(
    service,
    /ExecStart="\/usr\/bin\/node" "\/home\/me\/app\/sync\.js" "100%%" "has space"/,
  );
  assert.match(service, /Environment="VALUE=a\$b%%"/);
  assert.match(service, /StandardOutput="append:\/home\/me\/\.logs\/out\.log"/);
  assert.match(timer, /OnCalendar=\*-\*-15 6:0:00/);
  assert.match(timer, /OnCalendar=Mon \*-\*-\* 6:0:00/);
  assert.match(timer, /Persistent=true/);
});

test("renders startup schedules as enabled user services without timers", () => {
  const service = renderSystemdService(
    { ...OPTIONS, schedule: "@reboot" },
    parseCronExpression("@login"),
  );

  assert.match(service, /RemainAfterExit=true/);
  assert.match(service, /WantedBy=default\.target/);
});

test("registers startup services and removes an existing timer", async () => {
  const home = await mkdtemp(join(tmpdir(), "native-cron-linux-startup-"));
  const runner = new FakeRunner((command, args) => {
    if (command === "systemctl" && args.includes("is-active")) {
      return SUCCESS;
    }
    return SUCCESS;
  });
  const driver = new LinuxDriver({ home, uid: 1000, runner });
  const options = {
    ...OPTIONS,
    schedule: "@reboot",
    cwd: home,
    stdout: undefined,
    stderr: undefined,
  };

  try {
    await driver.register(options, parseCronExpression(options.schedule));
    const status = await driver.status(options.name);
    assert.match(await readFile(status.configPaths[0], "utf8"), /WantedBy=default\.target/);
    await assert.rejects(readFile(status.configPaths[1], "utf8"));
    assert.ok(
      runner.commands.some(
        ({ args }) =>
          args.includes("start") &&
          args.includes("--no-block") &&
          args.includes("native-cron-daily-sync.service"),
      ),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("manages systemd user units and treats removal as idempotent", async () => {
  const home = await mkdtemp(join(tmpdir(), "native-cron-linux-"));
  let active = false;
  const runner = new FakeRunner((command, args) => {
    if (command === "systemctl" && args.includes("is-active")) {
      return active ? SUCCESS : { code: 3, stdout: "inactive", stderr: "" };
    }
    if (command === "systemctl" && args.includes("restart")) {
      active = true;
    }
    if (command === "systemctl" && args.includes("--now") && args.includes("disable")) {
      active = false;
    }
    return SUCCESS;
  });
  const driver = new LinuxDriver({ home, uid: 1000, runner });
  const options = {
    ...OPTIONS,
    cwd: home,
    stdout: undefined,
    stderr: undefined,
  };

  try {
    await driver.register(options, parseCronExpression(options.schedule));
    const status = await driver.status(options.name);
    assert.equal(status.state, "active");
    assert.match(await readFile(status.configPaths[0], "utf8"), /Type=oneshot/);
    assert.match(await readFile(status.configPaths[1], "utf8"), /OnCalendar=/);

    await driver.stop(options.name);
    assert.equal((await driver.status(options.name)).state, "inactive");
    await driver.start(options.name);
    await driver.remove(options.name);
    await driver.remove(options.name);
    assert.equal((await driver.status(options.name)).state, "missing");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("uses XDG_CONFIG_HOME for systemd user units", async () => {
  const home = await mkdtemp(join(tmpdir(), "native-cron-xdg-home-"));
  const xdgConfigHome = await mkdtemp(join(tmpdir(), "native-cron-xdg-config-"));
  const runner = new FakeRunner((command, args) => {
    if (command === "systemctl" && args.includes("is-active")) {
      return { code: 3, stdout: "inactive", stderr: "" };
    }
    return SUCCESS;
  });
  const driver = new LinuxDriver({ home, xdgConfigHome, uid: 1000, runner });
  const options = { ...OPTIONS, cwd: home, stdout: undefined, stderr: undefined };

  try {
    await driver.register(options, parseCronExpression(options.schedule));
    const status = await driver.status(options.name);
    assert.ok(status.configPaths.every((path) => path.startsWith(xdgConfigHome)));
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(xdgConfigHome, { recursive: true, force: true });
  }
});

test("ignores relative XDG_CONFIG_HOME values", async () => {
  const home = await mkdtemp(join(tmpdir(), "native-cron-xdg-fallback-"));
  const runner = new FakeRunner((command, args) => {
    if (command === "systemctl" && args.includes("is-active")) {
      return { code: 3, stdout: "inactive", stderr: "" };
    }
    return SUCCESS;
  });
  const cron = createCronApi({ platform: "linux", home, xdgConfigHome: "relative", runner });

  try {
    const job = await cron({
      name: "xdg-fallback",
      schedule: "@daily",
      command: [process.execPath],
      cwd: home,
    });
    assert.ok(
      (await job.status()).configPaths.every((path) => path.startsWith(join(home, ".config"))),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
