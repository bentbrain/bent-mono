import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

const execute = promisify(execFile);
export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const isMain = (url) => Boolean(process.argv[1]) && url === pathToFileURL(resolve(process.argv[1])).href;
export async function aws(args) {
  try {
    const result = await execute(process.execPath, [resolve(ROOT, "scripts/aws-personal.mjs"), ...args], {
      cwd: ROOT, timeout: 150_000, maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout.trim() ? JSON.parse(result.stdout) : null;
  } catch {
    // Child-process errors contain full command arguments. Keep payloads out of logs.
    throw new Error(`Personal AWS ${args.slice(0, 2).join(" ")} failed. Check the guarded CLI directly.`);
  }
}
