import { parseArgs } from "node:util";
import { openReleaseArchive } from "./release-evidence.mjs";

const { values } = parseArgs({ options: { input: { type: "string" }, output: { type: "string" }, source: { type: "string" }, run: { type: "string" } } });
if (!values.input || !values.output) throw new Error("Supply a downloaded ciphertext archive and a new private output path.");
await openReleaseArchive(values.input, values.output, { sourceCommit: values.source, runId: values.run, filename: "browser-evidence.json" });
// Deliberately do not unpack an archive automatically. Inspect its entries in
// private storage before extracting with the original report paths preserved.
