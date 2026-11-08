import { resolveOperationalDispatch } from "./operational-dispatch-inputs.mjs";
process.umask(0o077);
try { await resolveOperationalDispatch(); }
catch { console.error("Shop operational dispatch was not authenticated; no operation started."); process.exit(1); }
