import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { JobDefinition } from "./jobs";

export async function runJob(path: string): Promise<void> {
  if (!path || !isAbsolute(path)) {
    throw new TypeError("Job module path must be absolute");
  }

  let module: { default?: Partial<JobDefinition> };
  try {
    module = (await import(pathToFileURL(path).href)) as {
      default?: Partial<JobDefinition>;
    };
  } catch (error) {
    throw new Error(`Unable to import job module ${path}`, { cause: error });
  }

  if (!module.default || typeof module.default.run !== "function") {
    throw new TypeError(`Default export from ${path} must define run()`);
  }
  await module.default.run();
}
