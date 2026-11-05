import { resolveDispatchInputs } from "./release-dispatch-inputs.mjs";
// Activated workflows accept ciphertext only. Decrypt before importing release
// modules so validated candidate selection observes the original protected input.
try { resolveDispatchInputs(process.env); }
catch { console.error("Shop dispatch evidence was not authenticated; no release operation started."); process.exit(1); }
