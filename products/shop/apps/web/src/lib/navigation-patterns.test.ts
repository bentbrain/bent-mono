import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

describe("navigation patterns", () => {
  it("keeps direct History API writes behind the mounted-route helper", async () => {
    const sourceFiles = await runtimeSourceFiles(sourceRoot);
    const directHistoryUsers: string[] = [];

    for (const file of sourceFiles) {
      const source = await readFile(file, "utf8");
      if (source.includes("window.history.")) {
        directHistoryUsers.push(relative(sourceRoot, file));
      }
    }

    expect(directHistoryUsers).toEqual(["lib/navigation.ts"]);
  });

  it("keeps product query mutations on nuqs", async () => {
    const [configurator, family] = await Promise.all([
      readFile(new URL("../components/product-configurator.tsx", import.meta.url), "utf8"),
      readFile(new URL("../components/product-family.tsx", import.meta.url), "utf8"),
    ]);

    for (const source of [configurator, family]) {
      expect(source).toContain("useQueryStates");
      expect(source).not.toContain("useRouter");
      expect(source).not.toContain("window.history.");
    }
  });
});

async function runtimeSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await runtimeSourceFiles(path));
    } else if (
      [".ts", ".tsx"].includes(extname(entry.name)) &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test.tsx")
    ) {
      files.push(path);
    }
  }

  return files.sort();
}
