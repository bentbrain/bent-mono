import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import { readRegularFile } from "./read-regular-file.mjs";
import { sealDispatchInputs } from "./release-dispatch-inputs.mjs";

const { values } = parseArgs({ options: { field: { type: "string" }, source: { type: "string" }, input: { type: "string" }, output: { type: "string" } } });
if (!["promotion_input", "qualification_reference", "renderer_reference", "rollback_reference"].includes(values.field) || !values.input || !values.output) throw new Error("Choose an allowlisted dispatch field and private input/output files.");
const value = (await readRegularFile(values.input, { minBytes: 1, maxBytes: 65536 })).toString("utf8");
const sealed = sealDispatchInputs({ [values.field]: value }, values.source);
await writeFile(values.output, sealed[values.field], { flag: "wx", mode: 0o600 });
