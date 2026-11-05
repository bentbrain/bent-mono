import { appendFileSync } from "node:fs";
const stages = new Map();

export function releaseProgress(releaseId, stage, detail = "", now = Date.now(), env = process.env) {
  if (env.GITHUB_ACTIONS !== "true" || !/^[a-z][a-z-]{0,39}$/.test(env.NATIVE_OPERATION ?? "")) return;
  if (!/^native-\d+$/.test(releaseId) || !/^[a-z][a-z-]{0,39}$/.test(stage) || !/^[a-zA-Z0-9 ;=.-]{0,160}$/.test(detail)) return;
  const previous = stages.get(releaseId);
  if (previous?.stage === stage && now - previous.at < 60000) return;
  const message = `[release ${releaseId}] ${stage}; ${new Date(now).toISOString()}${detail ? `; ${detail}` : ""}`;
  console.info(message);
  stages.set(releaseId, { stage, at: now });
  // Observability is best effort; a summary write must never interrupt a release
  // after its durable evidence or mutation has succeeded.
  if (env.GITHUB_STEP_SUMMARY) {
    try { appendFileSync(env.GITHUB_STEP_SUMMARY, `${message}\n\n`); }
    catch { console.warn("Could not append release progress to the Actions summary."); }
  }
}
