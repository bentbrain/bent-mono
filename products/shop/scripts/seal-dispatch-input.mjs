import { sealOperationalInput } from "./operational-dispatch-inputs.mjs";
import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import { readRegularFile } from "./read-regular-file.mjs";
import { sealDispatchInputs } from "./release-dispatch-inputs.mjs";

const { values } = parseArgs({ options: { field: { type: "string" }, source: { type: "string" }, input: { type: "string" }, output: { type: "string" }, workflow: { type: "string" }, environment: { type: "string" }, operation: { type: "string" } } });
if (!["promotion_input", "qualification_reference", "renderer_reference", "rollback_reference", "forward_recovery_reference", "private_input"].includes(values.field) || !values.input || !values.output) throw new Error("Choose an allowlisted dispatch field and private input/output files.");
const value = (await readRegularFile(values.input, { minBytes: 1, maxBytes: 65536 })).toString("utf8");
const sealed = values.field === "private_input"
  ? sealOperationalInput({ workflow: values.workflow, environment: values.environment, operation: values.operation, sourceCommit: values.source, inputs: JSON.parse(value) })
  : sealDispatchInputs({ [values.field]: value }, values.source)[values.field];
await writeFile(values.output, sealed, { flag: "wx", mode: 0o600 });
