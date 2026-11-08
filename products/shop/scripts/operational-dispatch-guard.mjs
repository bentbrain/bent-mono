import { resolveOperationalDispatch } from "./operational-dispatch-inputs.mjs";
try { await resolveOperationalDispatch(); }
catch { console.error("Shop operational dispatch was not authenticated; no operation started."); process.exit(1); }
