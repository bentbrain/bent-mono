import { execFileSync } from "node:child_process";
import { readFile, writeFile, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const root = new URL("../", import.meta.url);
execFileSync(
  "cargo",
  [
    "build",
    "--release",
    "--target",
    "wasm32-unknown-unknown",
    "--manifest-path",
    new URL("wasm/Cargo.toml", root).pathname,
  ],
  { stdio: "inherit" },
);
await copyFile(
  new URL(
    "wasm/target/wasm32-unknown-unknown/release/product_image_displacement.wasm",
    root,
  ),
  new URL("assets/displacement.wasm", root),
);
const files = {};
for (const path of [
  "wasm/Cargo.toml",
  "wasm/Cargo.lock",
  "wasm/src/lib.rs",
  "assets/displacement.wasm",
])
  files[path] = createHash("sha256")
    .update(await readFile(new URL(path, root)))
    .digest("hex");
await writeFile(
  new URL("assets/displacement-build.json", root),
  JSON.stringify(
    {
      compiler: execFileSync("rustc", ["--version"], {
        encoding: "utf8",
      }).trim(),
      files,
    },
    null,
    2,
  ) + "\n",
);
