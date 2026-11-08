import { operationalArtifactPaths } from "./seal-operational-artifacts.mjs";
import { parseArgs } from "node:util";
import { openReleaseArchive } from "./release-evidence.mjs";

if (process.env.GITHUB_ACTIONS === "true") throw new Error("Open private evidence outside GitHub Actions.");
const { values } = parseArgs({ options: { input: { type: "string" }, output: { type: "string" }, source: { type: "string" }, run: { type: "string" }, workflow: { type: "string" } } });
if (values.workflow && !Object.hasOwn(operationalArtifactPaths, values.workflow)) throw new Error("Choose a supported operational workflow.");
if (!values.input || !values.output) throw new Error("Supply a downloaded ciphertext archive and a new private output path.");
await openReleaseArchive(values.input, values.output, { sourceCommit: values.source, runId: values.run, filename: values.workflow ? `${values.workflow.slice(0, -4)}-evidence.json` : "browser-evidence.json" });
// Deliberately do not unpack an archive automatically. Inspect its entries in
// private storage before extracting with the original report paths preserved.
