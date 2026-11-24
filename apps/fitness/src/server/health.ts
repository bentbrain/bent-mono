/**
 * Imports Apple Health weigh-ins and runs sent by Health Auto Export or an
 * Apple Shortcut. Each Health sample maps to a fixed record ID, so repeated
 * syncs of the same days save each sample once.
 */
import { runSchema, settingsId, settingsSchema, weightSchema } from "../domain";
import type { Entity, RecordEntry } from "../domain";
import {
  AgentAuthError,
  AgentScopeError,
  agentScopes,
  requireApiKeyOwner,
} from "./auth";
import type { AgentAccess } from "./auth";
import {
  HealthImportError,
  healthImportLimits,
  healthRecordId,
  isHealthRecordId,
  readHealthExport,
  sameRun,
} from "./health-export";
import { BatchConflict, StoreRuleError, changeAccount } from "./store";

type Outcome = { date: string; status: "added" | "kept"; reason?: string };

const reasons = {
  imported: "Imported in an earlier sync.",
  removed: "Removed in Fitness after an earlier sync.",
  weighIn: "A weigh-in is already recorded for this date.",
  run: "A run with about the same distance is already recorded for this date.",
};

function timezoneOf(records: RecordEntry[]) {
  const stored = records.find((r) => r.id === settingsId)?.data;
  return stored?.kind === "settings"
    ? settingsSchema.parse(stored).timezone
    : "UTC";
}

function created(id: string, data: Entity) {
  return { operationId: crypto.randomUUID(), id, revision: 0, data };
}

/**
 * Saves new weigh-ins and runs from one Health export. A weigh-in or run
 * already in Fitness, imported earlier or removed after import stays as it is.
 * Connections with read access get each sample's outcome; write-only
 * connections get the counts they sent, so the reply does not show what the
 * account holds.
 */
export async function importHealth(
  owner: string,
  access: AgentAccess,
  body: unknown,
) {
  return changeAccount(owner, async (change) => {
    const records = await change.records();
    const samples = readHealthExport(body, timezoneOf(records));
    const weightIds = samples.weights.map((w) =>
      healthRecordId("weight:" + w.date),
    );
    const runIds = samples.runs.map((r) => healthRecordId("run:" + r.start));
    const used = await change.used([...weightIds, ...runIds]);
    const live = new Set(records.map((r) => r.id));
    const previously = (id: string) =>
      live.has(id) ? reasons.imported : reasons.removed;

    const weights: Outcome[] = [];
    for (const [i, weight] of samples.weights.entries()) {
      const id = weightIds[i] ?? "";
      const recorded = records.some(
        (r) => r.data.kind === "weight" && r.data.date === weight.date,
      );
      const reason = used.has(id)
        ? previously(id)
        : recorded
          ? reasons.weighIn
          : null;
      if (reason) {
        weights.push({ date: weight.date, status: "kept", reason });
        continue;
      }
      await change.save(
        created(
          id,
          weightSchema.parse({
            kind: "weight",
            date: weight.date,
            kg: weight.kg,
          }),
        ),
      );
      weights.push({ date: weight.date, status: "added" });
    }

    const runs: (Outcome & { start: string })[] = [];
    // Runs entered in Fitness. Each one stands in for at most one Health run.
    const entered = records.filter(
      (r) => r.data.kind === "run" && !isHealthRecordId(r.id),
    );
    for (const [i, run] of samples.runs.entries()) {
      const id = runIds[i] ?? "";
      const match = used.has(id)
        ? -1
        : entered.findIndex(
            (r) =>
              r.data.kind === "run" &&
              r.data.date === run.date &&
              sameRun(r.data, run),
          );
      const reason = used.has(id)
        ? previously(id)
        : match >= 0
          ? reasons.run
          : null;
      if (reason) {
        if (match >= 0) entered.splice(match, 1);
        runs.push({ date: run.date, start: run.start, status: "kept", reason });
        continue;
      }
      await change.save(
        created(
          id,
          runSchema.parse({
            kind: "run",
            date: run.date,
            minutes: run.minutes,
            distanceKm: run.distanceKm,
            notes: "Apple Health",
          }),
        ),
      );
      runs.push({ date: run.date, start: run.start, status: "added" });
    }

    const added = {
      weights: weights.filter((w) => w.status === "added").length,
      runs: runs.filter((r) => r.status === "added").length,
    };
    if (!access.read)
      return {
        received: {
          weights: samples.weights.length,
          runs: samples.runs.length,
        },
        skipped: samples.skipped,
      };
    return {
      added,
      weights,
      runs,
      skipped: samples.skipped,
      ignored: samples.ignored,
    };
  });
}

const noStore = { "Cache-Control": "no-store" };
function json(value: unknown, status = 200, headers: HeadersInit = {}) {
  return Response.json(value, { status, headers: { ...noStore, ...headers } });
}

async function readBody(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > healthImportLimits.bytes) return null;
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > healthImportLimits.bytes) return null;
  return new TextDecoder().decode(bytes);
}

/** POST /api/health/import: one Health export per request, authorized by an API key. */
export async function handleHealthImport(request: Request) {
  let agent: Awaited<ReturnType<typeof requireApiKeyOwner>>;
  try {
    agent = await requireApiKeyOwner(request);
  } catch (error) {
    if (error instanceof AgentAuthError)
      return json({ error: error.message }, 401, {
        "WWW-Authenticate": `Bearer error="invalid_token"`,
      });
    if (error instanceof AgentScopeError)
      return json({ error: error.message }, 403);
    throw error;
  }
  if (!agent.access.write)
    return json(
      { error: `Use an API key with ${agentScopes.write} access.` },
      403,
    );
  const text = await readBody(request);
  if (text === null)
    return json(
      {
        error:
          "Send up to 4 MB per request. Turn on Batch Requests in Health Auto Export, or sync a shorter date range.",
      },
      413,
    );
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "Send the export as JSON." }, 400);
  }
  try {
    return json(await importHealth(agent.owner, agent.access, body));
  } catch (error) {
    if (error instanceof HealthImportError || error instanceof StoreRuleError)
      return json({ error: error.message }, 400);
    if (error instanceof BatchConflict)
      return json(
        { error: "An entry changed while saving. Send the export again." },
        409,
      );
    console.error("fitness.health.import_failed", {
      name: error instanceof Error ? error.name : typeof error,
    });
    return json({ error: "The import could not be saved. Try again." }, 500);
  }
}
