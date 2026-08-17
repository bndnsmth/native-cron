import { constants } from "node:fs";
import { access, chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function atomicWrite(
  path: string,
  contents: string | Uint8Array,
  mode = 0o600,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporaryPath, contents, { mode, flag: "wx" });
    await chmod(temporaryPath, mode);
    try {
      await rename(temporaryPath, path);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        (error.code !== "EEXIST" && error.code !== "EPERM")
      ) {
        throw error;
      }
      await rm(path, { force: true });
      await rename(temporaryPath, path);
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function ensureOutputDirectory(path: string | undefined): Promise<void> {
  if (path) {
    await mkdir(dirname(path), { recursive: true });
  }
}

export function resolveFrom(base: string, path: string): string {
  return isAbsolute(path) ? path : resolve(base, path);
}
