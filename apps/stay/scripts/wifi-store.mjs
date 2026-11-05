import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { wifiPasswordSchema } from "../src/lib/wifi-types.ts";

export function createWifiStore(path) {
  return {
    async read() {
      let text;
      try {
        text = await readFile(path, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") return { password: null };
        throw error;
      }
      return wifiPasswordSchema.parse(JSON.parse(text));
    },
    async write(value) {
      const data = wifiPasswordSchema.parse(value);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
      await rename(temporary, path);
    },
  };
}

export const wifiStore = createWifiStore(
  fileURLToPath(new URL("../private/guest-wifi.json", import.meta.url)),
);
