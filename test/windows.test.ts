import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { parseCronExpression } from "../src/cron-expression";
import { renderPowerShellWrapper, renderTaskXml, WindowsDriver } from "../src/drivers/windows";
import type { NormalizedCronOptions } from "../src/types";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeRunner, SUCCESS } from "./helpers";

const OPTIONS: NormalizedCronOptions = {
  name: "backup",
  schedule: "*/15 * * * *",
  command: ["C:\\Program Files\\nodejs\\node.exe", "C:\\My App\\backup.js", "it's safe"],
  cwd: "C:\\My App",
  env: { NODE_ENV: "production", TOKEN: "it's secret" },
  stdout: "C:\\Logs\\out.log",
  stderr: "C:\\Logs\\err.log",
};

test("renders a PowerShell wrapper without interpolating values as code", () => {
  const wrapper = renderPowerShellWrapper(OPTIONS);

  assert.match(wrapper, /\$env:TOKEN = 'it''s secret'/);
  assert.match(
    wrapper,
    /& 'C:\\Program Files\\nodejs\\node\.exe' 'C:\\My App\\backup\.js' 'it''s safe'/,
  );
  assert.match(wrapper, /1>> 'C:\\Logs\\out\.log' 2>> 'C:\\Logs\\err\.log'/);
});

test("compresses regular intervals into one Windows trigger", () => {
  const xml = renderTaskXml(
    OPTIONS,
    parseCronExpression(OPTIONS.schedule),
    "C:\\native-cron\\backup.ps1",
    "DOMAIN\\me",
  );

  assert.equal((xml.match(/<CalendarTrigger>/g) ?? []).length, 1);
  assert.match(xml, /<Interval>PT15M<\/Interval>/);
  assert.match(xml, /<LogonType>S4U<\/LogonType>/);
  assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
  assert.match(xml, /-File C:\\native-cron\\backup\.ps1/);

  const hourly = renderTaskXml(
    OPTIONS,
    parseCronExpression("0 * * * *"),
    "C:\\native-cron\\backup.ps1",
    "DOMAIN\\me",
  );
  assert.match(hourly, /<Interval>PT60M<\/Interval>/);
});

test("renders startup schedules as Windows logon triggers", () => {
  const xml = renderTaskXml(
    { ...OPTIONS, schedule: "@reboot" },
    parseCronExpression("@login"),
    "C:\\native-cron\\backup.ps1",
    "DOMAIN\\me",
  );

  assert.match(
    xml,
    /<LogonTrigger><Enabled>true<\/Enabled><UserId>DOMAIN\\me<\/UserId><\/LogonTrigger>/,
  );
  assert.doesNotMatch(xml, /<CalendarTrigger>/);
});

test("runs startup tasks when they are registered and re-enabled", async () => {
  const home = await mkdtemp(join(tmpdir(), "native-cron-windows-startup-"));
  const runner = new FakeRunner((command, args) => {
    if (command === "schtasks.exe" && args[0] === "/query") {
      return {
        code: 0,
        stdout: "<Task><Settings><Enabled>true</Enabled></Settings></Task>",
        stderr: "",
      };
    }
    return SUCCESS;
  });
  const driver = new WindowsDriver({ home, uid: -1, userId: "DOMAIN\\me", runner });
  const options = {
    ...OPTIONS,
    schedule: "@reboot",
    cwd: home,
    stdout: undefined,
    stderr: undefined,
  };

  try {
    await driver.register(options, parseCronExpression(options.schedule));
    await driver.start(options.name);
    assert.equal(
      runner.commands.filter(
        ({ command, args }) => command === "schtasks.exe" && args[0] === "/run",
      ).length,
      2,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("splits day-of-month and weekday restrictions to preserve cron OR logic", () => {
  const schedule = parseCronExpression("0 9 15 JAN MON-FRI");
  const xml = renderTaskXml(OPTIONS, schedule, "C:\\native-cron\\backup.ps1", "DOMAIN\\me");

  assert.equal((xml.match(/<CalendarTrigger>/g) ?? []).length, 2);
  assert.match(xml, /<ScheduleByMonth>/);
  assert.match(xml, /<ScheduleByMonthDayOfWeek>/);
});

test("rejects expressions that exceed the Windows 48-trigger limit", () => {
  assert.throws(
    () =>
      renderTaskXml(
        OPTIONS,
        parseCronExpression("*/7 * * * *"),
        "C:\\native-cron\\backup.ps1",
        "DOMAIN\\me",
      ),
    /platform limit is 48/,
  );
});

test("manages and reports a Windows scheduled task", async () => {
  const home = await mkdtemp(join(tmpdir(), "native-cron-windows-"));
  let registered = false;
  let enabled = true;
  const runner = new FakeRunner((command, args) => {
    if (command !== "schtasks.exe") {
      return SUCCESS;
    }
    if (args[0] === "/create") {
      registered = true;
      enabled = true;
      return SUCCESS;
    }
    if (args[0] === "/query") {
      return registered
        ? {
            code: 0,
            stdout: `<Task><Settings><Enabled>${enabled}</Enabled></Settings></Task>`,
            stderr: "",
          }
        : { code: 0x80070002, stdout: "", stderr: "Task not found" };
    }
    if (args[0] === "/change") {
      enabled = args.includes("/enable");
      return SUCCESS;
    }
    if (args[0] === "/delete") {
      registered = false;
      return SUCCESS;
    }
    return SUCCESS;
  });
  const driver = new WindowsDriver({ home, uid: -1, userId: "DOMAIN\\me", runner });
  const options = { ...OPTIONS, cwd: home, stdout: undefined, stderr: undefined };

  try {
    await driver.register(options, parseCronExpression(options.schedule));
    const registeredStatus = await driver.status(options.name);
    assert.equal(registeredStatus.state, "active");
    const xmlBytes = await readFile(registeredStatus.configPaths[0]);
    const scriptBytes = await readFile(registeredStatus.configPaths[1]);
    assert.deepEqual([...xmlBytes.subarray(0, 2)], [0xff, 0xfe]);
    assert.deepEqual([...scriptBytes.subarray(0, 2)], [0xff, 0xfe]);
    await driver.stop(options.name);
    assert.equal((await driver.status(options.name)).state, "inactive");
    await driver.start(options.name);
    assert.equal((await driver.status(options.name)).state, "active");
    await driver.remove(options.name);
    assert.equal((await driver.status(options.name)).state, "missing");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("restores local state when Windows task creation fails", async () => {
  const home = await mkdtemp(join(tmpdir(), "native-cron-windows-failed-create-"));
  const runner = new FakeRunner((command, args) => {
    if (command === "schtasks.exe" && args[0] === "/create") {
      return { code: 1, stdout: "", stderr: "Task creation failed" };
    }
    if (command === "schtasks.exe" && args[0] === "/query") {
      return { code: 0x80070002, stdout: "", stderr: "Task not found" };
    }
    return SUCCESS;
  });
  const driver = new WindowsDriver({ home, uid: -1, userId: "DOMAIN\\me", runner });
  const options = { ...OPTIONS, cwd: home, stdout: undefined, stderr: undefined };

  try {
    await assert.rejects(
      driver.register(options, parseCronExpression(options.schedule)),
      /Task creation failed/,
    );
    const status = await driver.status(options.name);
    assert.equal(status.state, "missing");
    for (const path of status.configPaths) {
      await assert.rejects(readFile(path), /ENOENT/);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("removes local files after a Windows task is deleted externally", async () => {
  const home = await mkdtemp(join(tmpdir(), "native-cron-windows-orphan-"));
  let registered = false;
  const runner = new FakeRunner((command, args) => {
    if (command === "schtasks.exe" && args[0] === "/create") {
      registered = true;
      return SUCCESS;
    }
    if (command === "schtasks.exe" && args[0] === "/query") {
      return registered
        ? {
            code: 0,
            stdout: "<Task><Settings><Enabled>true</Enabled></Settings></Task>",
            stderr: "",
          }
        : { code: 0x80070002, stdout: "", stderr: "Task not found" };
    }
    return SUCCESS;
  });
  const driver = new WindowsDriver({ home, uid: -1, userId: "DOMAIN\\me", runner });
  const options = { ...OPTIONS, cwd: home, stdout: undefined, stderr: undefined };

  try {
    await driver.register(options, parseCronExpression(options.schedule));
    const paths = (await driver.status(options.name)).configPaths;
    registered = false;
    assert.equal((await driver.status(options.name)).state, "missing");
    await driver.remove(options.name);
    for (const path of paths) {
      await assert.rejects(readFile(path), /ENOENT/);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("reports Windows Task Scheduler query failures", async () => {
  const runner = new FakeRunner((command, args) => {
    if (command === "schtasks.exe" && args[0] === "/query") {
      return { code: 0x80070005, stdout: "", stderr: "Access denied" };
    }
    return SUCCESS;
  });
  const driver = new WindowsDriver({
    home: "C:\\Users\\me",
    uid: -1,
    userId: "DOMAIN\\me",
    runner,
  });

  await assert.rejects(driver.status("backup"), /Access denied/);
});

test("uses LOCALAPPDATA for private Windows configuration", async () => {
  const home = await mkdtemp(join(tmpdir(), "native-cron-windows-home-"));
  const localAppData = await mkdtemp(join(tmpdir(), "native-cron-windows-local-"));
  const runner = new FakeRunner((command, args) => {
    if (command === "schtasks.exe" && args[0] === "/query") {
      return {
        code: 0,
        stdout: "<Task><Settings><Enabled>true</Enabled></Settings></Task>",
        stderr: "",
      };
    }
    return SUCCESS;
  });
  const driver = new WindowsDriver({
    home,
    localAppData,
    uid: -1,
    userId: "DOMAIN\\me",
    runner,
  });
  const options = { ...OPTIONS, cwd: home, stdout: undefined, stderr: undefined };

  try {
    await driver.register(options, parseCronExpression(options.schedule));
    assert.ok(
      (await driver.status(options.name)).configPaths.every((path) =>
        path.startsWith(localAppData),
      ),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(localAppData, { recursive: true, force: true });
  }
});
