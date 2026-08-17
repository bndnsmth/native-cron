# native-cron

> **Cross-platform OS-level cron for Node.js.**
>
> No daemon. No timers. No resident Node process.

`native-cron` registers commands with the scheduler already built into the operating system. The setup process exits; launchd, systemd, or Windows Task Scheduler starts a fresh process when the schedule fires.

```sh
npm install native-cron
```

Create the job next to `cron.js`:

```txt
my-app/
├── cron.js
└── backup.js
```

```js
// backup.js
console.log("Running backup");
```

```js
// cron.js
import { cron } from "native-cron";

await cron({
  name: "backup",
  schedule: "0 2 * * *",
  command: [process.execPath, "backup.js"],
});
```

Run registration once:

```sh
node cron.js
```

After that call resolves, this process can exit.

```txt
node cron.js
     |
     +-- writes native scheduler configuration
     +-- loads and enables the job
     `-- exits

                   later

OS scheduler -----------------> node backup.js
```

`native-cron` is intentionally not an in-process scheduling library. If the operating system is not scheduling the command, it is outside this package's scope.

## Why

Popular Node cron packages run callbacks from a long-lived Node process. That is useful for servers, but it means the application is also the scheduler.

| Package or API | Scheduler        | Node/Bun stays running |
| -------------- | ---------------- | ---------------------- |
| `node-cron`    | In-process timer | Yes                    |
| `cron`         | In-process timer | Yes                    |
| `Bun.cron()`   | Operating system | No                     |
| `native-cron`  | Operating system | No                     |

`native-cron` brings the OS-owned model and small API to Node.js. Its object form is inspired by Bun's OS-level cron API, while allowing any executable and arguments instead of requiring a module handler.

## API

### Register or Replace

`cron()` registers one command. Only `name`, `schedule`, and `command` are required:

```js
import { cron } from "native-cron";

const job = await cron({
  name: "backup",
  schedule: "0 2 * * *",
  command: [process.execPath, "backup.js"],
});
```

Registration is an upsert. Calling `cron()` again with the same `name` replaces the native configuration and activates the new schedule.

The executable is resolved to an absolute path during registration. Relative command arguments are evaluated from the persisted working directory, which defaults to the directory where `cron.js` was run.

Set `cwd`, `env`, `stdout`, or `stderr` only when the job needs them:

```js
await cron({
  name: "backup",
  schedule: "0 2 * * *",
  command: [process.execPath, "backup.js"],
  cwd: "/srv/my-app",
  env: { NODE_ENV: "production" },
  stdout: "/srv/my-app/logs/backup.log",
  stderr: "/srv/my-app/logs/backup.err.log",
});
```

Relative `cwd`, `stdout`, and `stderr` paths are resolved during registration. Output directories are created automatically. Only variables supplied through `env` are added explicitly; the command otherwise receives the base environment provided by the native scheduler.

### Lifecycle

The returned handle operates on the persistent native job:

```ts
await job.stop(); // disable/unload, preserving configuration
await job.start(); // enable/load again
await job.remove(); // unregister and delete configuration

console.log(await job.status());
```

Retrieve a handle in another process by name:

```ts
import { getJob, removeJob } from "native-cron";

const job = getJob("backup");
await job.stop();
await job.start();

await removeJob("backup");
```

The same operations are also available as `cron.get(name)` and `cron.remove(name)`. Removal is idempotent.

`status()` returns:

```ts
interface JobStatus {
  name: string;
  platform: "darwin" | "linux" | "win32";
  state: "active" | "inactive" | "missing";
  configPaths: readonly string[];
  schedule?: string;
  command?: readonly string[];
}
```

`schedule` and `command` are present when the handle came directly from `cron(options)`. A name-only handle does not read secrets or command data back from native configuration.

### Convenience: Job Directories

For applications with several jobs, `defineJob()` and `registerJobs()` provide optional convention-based discovery.

`defineJob()` validates a job's name, schedule, `run` function, environment, and paths immediately, freezes the definition, and preserves TypeScript inference. It does not register or execute anything. Plain default-exported objects are accepted too, so calling it is optional in JavaScript.

```js
// This is also valid.
export default {
  name: "cleanup-temp",
  schedule: "@hourly",
  async run() {},
};
```

`registerJobs(directory, options?)` performs the work:

1. Discovers `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, and `.cts` files.
2. Imports and validates every default export.
3. Rejects duplicate names before registering any job.
4. Registers each file through the operating system scheduler.
5. Configures a fresh Node process to import the file and invoke `run()` when due.

By default, only files directly inside the directory are loaded. Set `recursive: true` to include subdirectories. Type declaration files such as `job.d.ts` are ignored.

```ts
await registerJobs(new URL("./jobs/", import.meta.url), {
  recursive: true,
  cwd: import.meta.dirname,
  env: {
    NODE_ENV: "production",
  },
  stderr: "./logs/jobs.error.log",
});
```

`cwd`, `env`, `stdout`, and `stderr` are optional shared defaults. A value defined by an individual job overrides the shared value; job environment variables merge over shared environment variables.

```ts
export default defineJob({
  name: "daily-sync",
  schedule: "0 6 * * *",
  stderr: "./logs/daily-sync.error.log",
  env: { SYNC_MODE: "full" },

  async run() {},
});
```

The result is an array of lifecycle handles enriched with the source path and definition:

```ts
const jobs = await registerJobs(new URL("./jobs/", import.meta.url));

await jobs[0].stop();
await jobs[0].start();
console.log(jobs[0].path);
```

Registration is an upsert, but it does not remove native jobs whose source files were deleted. Remove those explicitly by name with `removeJob()`.

Registered directory jobs store absolute paths to the current Node executable, the installed `native-cron` runner, and the job module. Re-register jobs after moving the application, changing Node installations, or replacing dependencies, and keep those paths available between registrations.

#### TypeScript Jobs

TypeScript jobs use Node's native type stripping, with no `tsx`, `ts-node`, or compilation step. They require Node.js 22.6 or newer. Node.js 22.6 through 22.17 must run the registration file with `--experimental-strip-types`; stripping is enabled by default in Node.js 22.18 and newer. Use erasable TypeScript syntax and include file extensions in relative imports:

```ts
import { sendReport } from "../lib/report.ts";
```

Node applies the nearest `package.json` module type to `.ts` and `.js` files. The ESM examples above require:

```json
{
  "type": "module"
}
```

Alternatively, use `.mts`/`.mjs` for ESM or `.cts`/`.cjs` for CommonJS explicitly.

Node does not read `tsconfig.json` while executing TypeScript. Path aliases, enums, parameter properties, runtime namespaces, and other syntax requiring transformation are not supported unless the application uses a separate loader or build step. `native-cron` deliberately uses stripping rather than `--experimental-transform-types`.

## Schedule Syntax

Calendar schedules use the standard five-field cron format in the operating system's local time zone:

```txt
minute hour day-of-month month day-of-week
```

| Field        | Values                | Operators       |
| ------------ | --------------------- | --------------- |
| Minute       | `0`-`59`              | `*` `,` `-` `/` |
| Hour         | `0`-`23`              | `*` `,` `-` `/` |
| Day of month | `1`-`31`              | `*` `,` `-` `/` |
| Month        | `1`-`12`, `JAN`-`DEC` | `*` `,` `-` `/` |
| Day of week  | `0`-`7`, `SUN`-`SAT`  | `*` `,` `-` `/` |

Names are case-insensitive and may be abbreviated or written in full. Both `0` and `7` mean Sunday.

```ts
await cron({
  name: "weekday-report",
  schedule: "30 9 * * MON-FRI",
  command: [process.execPath, "/absolute/path/report.js"],
});
```

Supported nicknames:

| Nickname               | Equivalent  |
| ---------------------- | ----------- |
| `@yearly`, `@annually` | `0 0 1 1 *` |
| `@monthly`             | `0 0 1 * *` |
| `@weekly`              | `0 0 * * 0` |
| `@daily`, `@midnight`  | `0 0 * * *` |
| `@hourly`              | `0 * * * *` |

Startup nicknames:

| Nickname  | Behavior                                     |
| --------- | -------------------------------------------- |
| `@reboot` | Run when the user's native scheduler starts  |
| `@login`  | Alias for `@reboot`; normalizes to `@reboot` |

Because `native-cron` installs per-user jobs, these nicknames mean user-session startup rather than privileged machine boot. Registering or calling `start()` on a startup job loads it into the current session and runs it immediately. Native overlap prevention still applies.

When day-of-month and day-of-week are both restricted, either match fires the job. This is standard POSIX cron behavior and is preserved on all three backends.

The parser is public for validation and tooling:

```ts
import { parseCronExpression } from "native-cron";

const parsed = parseCronExpression("*/15 9-17 * * MON-FRI");
console.log(parsed.normalized);
```

## Native Backends

| Platform | Backend                   | Installed configuration                                                  |
| -------- | ------------------------- | ------------------------------------------------------------------------ |
| macOS    | Per-user launchd agent    | `~/Library/LaunchAgents/native-cron.<name>.plist`                        |
| Linux    | Per-user systemd timer    | `~/.config/systemd/user/native-cron-<name>.{service,timer}`              |
| Windows  | Task Scheduler, S4U logon | Task `native-cron-<name>` plus files under `%LOCALAPPDATA%\\native-cron` |

### macOS

The launchd agent uses `StartCalendarInterval` for calendar schedules and `RunAtLoad` for startup schedules, plus an argument array, an explicit working directory, and optional environment/output settings. `stop()` disables and unloads the agent while retaining its plist, including across future logins. `start()` enables and loads it again.

LaunchAgents become available with the user's graphical login session. The registration survives reboot, but a logged-out user agent does not run before that user session starts. launchd coalesces calendar events missed during sleep and runs once after wake.

Inspect a job:

```sh
launchctl print gui/$(id -u)/native-cron.backup
```

### Linux

For calendar schedules, the package writes a `Type=oneshot` service and a `Persistent=true` timer. For startup schedules, it writes an enabled user service under `default.target`. stdout and stderr go to the user journal unless file paths are configured.

User units run while that user's systemd manager is active. On a desktop this normally begins at login. For headless jobs that must run before login after reboot, an administrator can enable lingering once:

```sh
loginctl enable-linger "$USER"
```

Inspect jobs and logs:

```sh
systemctl --user status native-cron-backup.timer
journalctl --user -u native-cron-backup.service
```

### Windows

Task Scheduler receives an XML task definition with calendar triggers or a user logon trigger and runs a private PowerShell wrapper under the registering user with S4U logon. No password is stored, and calendar tasks can run while the user is logged out. S4U tasks cannot access Windows-authenticated network resources such as SMB shares or mapped drives.

Task Scheduler permits at most 48 triggers per task. `native-cron` compresses regular minute/hour intervals into one repetition trigger and rejects expressions whose remaining expansion exceeds that native limit.

```ts
// One repetition trigger: supported on Windows
schedule: "*/5 * * * *";

// 216 expanded triggers: rejected on Windows
schedule: "*/7 * * * *";
```

Inspect a job:

```powershell
schtasks /query /tn "native-cron-backup" /v
```

Windows containers generally do not run the Task Scheduler service and are not supported.

## Operational Semantics

- Registration and lifecycle methods resolve only after the native command succeeds.
- A job name contains only letters, numbers, hyphens, and underscores and is unique within `native-cron` on that user account.
- Registering an existing name replaces its schedule and command rather than creating a duplicate.
- `stop()` preserves configuration; `remove()` deletes it.
- Commands do not overlap by package-level coordination. Native behavior applies: launchd coalesces demand, systemd does not start a second active oneshot service, and Windows uses `IgnoreNew`.
- Missed executions follow the native scheduler. launchd coalesces after wake, systemd timers use `Persistent=true`, and Windows tasks use `StartWhenAvailable`.
- Schedules use local wall-clock time and therefore follow operating-system daylight-saving behavior.
- `@reboot` and `@login` startup jobs run when registered, when started after being stopped, and when the user's native scheduler starts in a future session.

## Security

- Command arguments are passed as native argument arrays or platform-specific escaped values; no POSIX shell is involved.
- Configuration is written atomically with user-only `0600` permissions where the platform supports POSIX modes.
- Windows configuration inherits the current user's `%LOCALAPPDATA%` access controls.
- `env`, arguments, and output paths may contain secrets and are stored on disk in native configuration or the private wrapper. Do not put credentials in this API unless that persistence is acceptable.
- Scheduled commands run with the registering user's privileges. `native-cron` does not elevate privileges.
- Use absolute script/data paths. Native schedulers provide a smaller environment than an interactive terminal.

## CommonJS

Both ESM and CommonJS are published:

```js
const { cron } = require("native-cron");
```

## Development

Requires Node.js 20.19 or newer and npm 11.16 or newer.

```sh
npm install
npm run check
npm test
npm pack --dry-run
```

## License

MIT.
