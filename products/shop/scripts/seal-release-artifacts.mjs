import { readdir, mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { readRegularFile } from "./read-regular-file.mjs";
import { sealReleaseEvidence } from "./release-evidence.mjs";

const source = process.env.WEB_RELEASE_EVIDENCE_DIR;
const temporary = process.env.RUNNER_TEMP;
if (!source || !temporary || !resolve(source).startsWith(`${resolve(temporary)}/`)) throw new Error("Private release evidence must remain in runner temporary storage.");
const destination = join(temporary, "sealed-web-production-evidence");
let files;
try { files = await readdir(source); }
catch (error) { if (error.code !== "ENOENT") throw error; files = []; }
if (files.length) {
  await mkdir(destination, { mode: 0o700 });
  for (const name of files) {
    if (basename(name) !== name || !/^[a-z][a-z0-9-]*\.json$/.test(name)) throw new Error("Unexpected release evidence filename.");
    const bytes = await readRegularFile(join(source, name), { minBytes: 1, maxBytes: 4 * 1024 * 1024 });
    const encoded = sealReleaseEvidence(JSON.parse(bytes), { sourceCommit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, filename: name });
    await writeFile(join(destination, name), encoded, { flag: "wx", mode: 0o600 });
  }
}
