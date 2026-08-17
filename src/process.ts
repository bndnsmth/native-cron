import { spawn } from "node:child_process";

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: readonly string[]): Promise<ProcessResult>;
}

export function decodeProcessOutput(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const littleEndian = Buffer.allocUnsafe(buffer.length - 2);
    for (let index = 2; index + 1 < buffer.length; index += 2) {
      littleEndian[index - 2] = buffer[index + 1];
      littleEndian[index - 1] = buffer[index];
    }
    return littleEndian.toString("utf16le");
  }
  if (buffer.length >= 4 && buffer[1] === 0 && buffer[3] === 0) {
    return buffer.toString("utf16le");
  }
  return buffer.toString("utf8");
}

export class NativeCommandError extends Error {
  readonly command: string;
  readonly code: number;
  readonly stderr: string;

  constructor(command: string, result: ProcessResult) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    super(`${command} failed: ${detail}`);
    this.name = "NativeCommandError";
    this.command = command;
    this.code = result.code;
    this.stderr = result.stderr;
  }
}

export const defaultCommandRunner: CommandRunner = {
  run(command: string, args: readonly string[]): Promise<ProcessResult> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", (error) => {
        rejectPromise(new Error(`Unable to run ${command}: ${error.message}`, { cause: error }));
      });
      child.once("close", (code) => {
        resolvePromise({
          code: code ?? 1,
          stdout: decodeProcessOutput(Buffer.concat(stdout)),
          stderr: decodeProcessOutput(Buffer.concat(stderr)),
        });
      });
    });
  },
};

export async function runChecked(
  runner: CommandRunner,
  command: string,
  args: readonly string[],
): Promise<ProcessResult> {
  const result = await runner.run(command, args);
  if (result.code !== 0) {
    throw new NativeCommandError([command, ...args].join(" "), result);
  }
  return result;
}
