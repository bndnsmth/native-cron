import type { CommandRunner, ProcessResult } from "../src/process";

export interface RecordedCommand {
  command: string;
  args: readonly string[];
}

export class FakeRunner implements CommandRunner {
  readonly commands: RecordedCommand[] = [];
  readonly #respond: (command: string, args: readonly string[]) => ProcessResult;

  constructor(
    respond: (command: string, args: readonly string[]) => ProcessResult = () => ({
      code: 0,
      stdout: "",
      stderr: "",
    }),
  ) {
    this.#respond = respond;
  }

  async run(command: string, args: readonly string[]): Promise<ProcessResult> {
    this.commands.push({ command, args });
    return this.#respond(command, args);
  }
}

export const SUCCESS: ProcessResult = { code: 0, stdout: "", stderr: "" };
