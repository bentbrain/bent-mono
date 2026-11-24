/**
 * Imports Apple Health weigh-ins and runs sent by Health Auto Export or an
 * Apple Shortcut. Fitness links each Health sample to the record it became,
 * or to the entry it matched, so repeated syncs decide each sample once.
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
  readHealthExport,
  sameRun,
} from "./health-export";
import { BatchConflict, StoreRuleError, changeHealth } from "./store";
import type { HealthLink } from "./store";

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

function created(data: Entity) {
  return {
    operationId: crypto.randomUUID(),
    id: crypto.randomUUID(),
    revision: 0,
    data,
  };
}

/**
 * Saves new weigh-ins and runs from one Health export.
 *
 * Each sample is decided once. A sample becomes a new entry, or matches an
 * entry already in Fitness: a weigh-in on the same date, or a run entered in
 * Fitness on the same date with about the same distance. Each entered run
 * matches at most one Health run. Later syncs keep that decision, so entries
 * changed or removed in Fitness stay as they are.
 *
 * Connections with read access get each sample's outcome; write-only
 * connections get the counts they sent, so the reply does not show what the
 * account holds.
 */
export async function importHealth(
  owner: string,
  access: AgentAccess,
  body: unknown,
) {
  return changeHealth(owner, async (change) => {
    const records = await change.records();
    const live = new Map(records.map((r) => [r.id, r]));
    const samples = readHealthExport(body, timezoneOf(records));
    const weightKey = (at: string) => "weight:" + at;
    const runKey = (start: string) => "run:" + start;
    const links = await change.links([
      ...samples.weights.flatMap((w) => w.samples.map((s) => weightKey(s.at))),
      ...samples.runs.map((r) => runKey(r.start)),
    ]);
    // The reason for a sample decided in an earlier sync. A match describes
    // that decision, since the entry may have changed since.
    const decided = (link: HealthLink, kind: string) =>
      !live.has(link.recordId)
        ? reasons.removed
        : !link.matched
          ? reasons.imported
          : `Matched to the ${kind} on ${link.date} in an earlier sync.`;
    const added: HealthLink[] = [];

    // Each weigh-in sample keeps its own decision. For each date, the earliest
    // undecided sample becomes the weigh-in or matches the date's weigh-in.
    const weights: Outcome[] = [];
    for (const weight of samples.weights) {
      const linked = weight.samples.flatMap((s) => {
        const link = links.get(weightKey(s.at));
        return link ? [link] : [];
      });
      const undecided = weight.samples.filter(
        (s) => !links.has(weightKey(s.at)),
      );
      const [first] = undecided;
      if (!first) {
        // Report the decision for this date: a live weigh-in on it first,
        // then a removed one, then a link made under another timezone.
        const onDate = linked.filter((l) => l.date === weight.date);
        const shown =
          onDate.find((l) => live.has(l.recordId)) ?? onDate[0] ?? linked[0];
        weights.push({
          date: weight.date,
          status: "kept",
          reason: shown ? decided(shown, "weigh-in") : "",
        });
        continue;
      }
      // New samples match the date's live weigh-in. A date whose synced
      // weigh-in was removed in Fitness, and has none now, stays without one.
      // Only links to a record on this date count, so a timezone change does
      // not carry a removal to another date.
      const removed = linked.find(
        (l) => l.date === weight.date && !live.has(l.recordId),
      );
      const recorded = records.find(
        (r) => r.data.kind === "weight" && r.data.date === weight.date,
      );
      let link: Omit<HealthLink, "sample" | "date">;
      if (recorded) {
        weights.push({
          date: weight.date,
          status: "kept",
          reason: reasons.weighIn,
        });
        link = { recordId: recorded.id, matched: true };
      } else if (removed) {
        weights.push({
          date: weight.date,
          status: "kept",
          reason: reasons.removed,
        });
        link = { recordId: removed.recordId, matched: removed.matched };
      } else {
        const saved = await change.save(
          created(
            weightSchema.parse({
              kind: "weight",
              date: weight.date,
              kg: first.kg,
            }),
          ),
        );
        if (!saved) throw new Error("Expected the saved weigh-in.");
        weights.push({ date: weight.date, status: "added" });
        link = { recordId: saved.id, matched: false };
      }
      for (const s of undecided)
        added.push({ sample: weightKey(s.at), date: weight.date, ...link });
    }

    const runs: (Outcome & { start: string })[] = [];
    // Runs entered in Fitness that no Health run has matched yet.
    const entered = records.filter((r) => r.data.kind === "run");
    const taken = await change.linked(entered.map((r) => r.id));
    const open = entered.filter((r) => !taken.has(r.id));
    for (const run of samples.runs) {
      const sample = runKey(run.start);
      const link = links.get(sample);
      if (link) {
        runs.push({
          date: run.date,
          start: run.start,
          status: "kept",
          reason: decided(link, "run"),
        });
        continue;
      }
      const match = open.findIndex(
        (r) =>
          r.data.kind === "run" &&
          r.data.date === run.date &&
          sameRun(r.data, run),
      );
      const existing = match >= 0 ? open.splice(match, 1)[0] : undefined;
      if (existing) {
        runs.push({
          date: run.date,
          start: run.start,
          status: "kept",
          reason: reasons.run,
        });
        added.push({
          sample,
          recordId: existing.id,
          date: run.date,
          matched: true,
        });
        continue;
      }
      const saved = await change.save(
        created(
          runSchema.parse({
            kind: "run",
            date: run.date,
            minutes: run.minutes,
            distanceKm: Math.round(run.distanceKm * 1000) / 1000,
            notes: "Apple Health",
          }),
        ),
      );
      if (!saved) throw new Error("Expected the saved run.");
      runs.push({ date: run.date, start: run.start, status: "added" });
      added.push({
        sample,
        recordId: saved.id,
        date: run.date,
        matched: false,
      });
    }
    await change.link(added);

    // Dates and skips depend on the account timezone, so a write-only
    // connection gets only counts taken from its own payload.
    if (!access.read) return { received: samples.sent };
    return {
      added: {
        weights: weights.filter((w) => w.status === "added").length,
        runs: runs.filter((r) => r.status === "added").length,
      },
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

/** Reads the body up to the size limit, stopping as soon as it is exceeded. */
export async function readImportBody(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > healthImportLimits.bytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > healthImportLimits.bytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
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
  const text = await readImportBody(request);
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
