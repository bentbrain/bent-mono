/**
 * Imports Apple Health weigh-ins and runs sent by the iPhone sync app, an
 * Apple Shortcut or a Health Auto Export JSON file. Fitness links each Health
 * sample to the record it became, or to the entry it matched, so repeated
 * syncs decide each sample once.
 */
import type {
  ApiErrorCode,
  DeviceReply,
  HealthImportReply,
} from "@bent/fitness-contracts";
import {
  localDate,
  runSchema,
  settingsId,
  settingsSchema,
  weightSchema,
} from "../domain";
import type { Entity, RecordEntry } from "../domain";
import { agentScopes, authenticateImport } from "./auth";
import type { AgentAccess } from "./auth";
import {
  HealthImportError,
  healthImportLimits,
  assignRuns,
  readDeviceExport,
  readHealthExport,
} from "./health-export";
import type { DeviceEntry } from "./health-export";
import { checkDeviceReply } from "./device-reply";
import { BatchConflict, StoreRuleError, changeHealth } from "./store";
import type { DeviceKeyClaims, HealthChange, HealthLink } from "./store";

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

/** A sample's decision, as the device reply reports it. */
type Decision =
  | { result: "added"; code: "new" }
  | {
      result: "kept";
      code: "already_imported" | "matched_existing" | "removed_in_fitness";
    }
  | { result: "kept"; code: "date_has_weighin" };

const weightKey = (at: string) => "weight:" + at;
const runKey = (start: string) => "run:" + start;

/**
 * Decides each new weigh-in and run in an open import and saves the result.
 *
 * Each sample is decided once. A sample becomes a new entry, or matches an
 * entry already in Fitness: a weigh-in on the same date, or a run entered in
 * Fitness on the same date with about the same distance. Each entered run
 * matches at most one Health run. Later syncs keep that decision, so entries
 * changed or removed in Fitness stay as they are.
 */
async function decide(
  change: HealthChange,
  records: RecordEntry[],
  samples: ReturnType<typeof readHealthExport>,
) {
  const live = new Map(records.map((r) => [r.id, r]));
  const decisions = new Map<string, Decision>();
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
  const earlier = (link: HealthLink): Decision => ({
    result: "kept",
    code: !live.has(link.recordId)
      ? "removed_in_fitness"
      : link.matched
        ? "matched_existing"
        : "already_imported",
  });
  const added: HealthLink[] = [];

  // Each weigh-in sample keeps its own decision. For each date, the earliest
  // undecided sample becomes the weigh-in or matches the date's weigh-in.
  const weights: Outcome[] = [];
  for (const weight of samples.weights) {
    const linked = weight.samples.flatMap((s) => {
      const link = links.get(weightKey(s.at));
      if (link) decisions.set(weightKey(s.at), earlier(link));
      return link ? [link] : [];
    });
    const undecided = weight.samples.filter((s) => !links.has(weightKey(s.at)));
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
    let link: Pick<HealthLink, "recordId" | "matched">;
    // The decision for the date's later new samples.
    let rest: Decision;
    if (recorded) {
      weights.push({
        date: weight.date,
        status: "kept",
        reason: reasons.weighIn,
      });
      link = { recordId: recorded.id, matched: true };
      rest = { result: "kept", code: "date_has_weighin" };
      decisions.set(weightKey(first.at), rest);
    } else if (removed) {
      weights.push({
        date: weight.date,
        status: "kept",
        reason: reasons.removed,
      });
      link = { recordId: removed.recordId, matched: removed.matched };
      rest = { result: "kept", code: "removed_in_fitness" };
      decisions.set(weightKey(first.at), rest);
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
      rest = { result: "kept", code: "date_has_weighin" };
      decisions.set(weightKey(first.at), { result: "added", code: "new" });
    }
    for (const s of undecided) {
      if (s !== first) decisions.set(weightKey(s.at), rest);
      added.push({
        sample: weightKey(s.at),
        date: weight.date,
        revision: null,
        distanceKm: null,
        minutes: null,
        ...link,
      });
    }
  }

  const runs: (Outcome & { start: string })[] = [];
  // Runs in Fitness, and the Health links that point to them. A match to an
  // entered run that is unchanged since can move to another entered run, or
  // give way to a closer new match, in which case its Health run is saved
  // as a new run. Other links stay as they are.
  const entered = records.filter((r) => r.data.kind === "run");
  const toEntered = await change.linksTo(entered.map((r) => r.id));
  const linkedIds = new Set(toEntered.map((l) => l.recordId));
  const movable = toEntered.filter((l) => {
    const record = live.get(l.recordId);
    return (
      l.matched &&
      l.distanceKm !== null &&
      l.minutes !== null &&
      record?.revision === l.revision &&
      record.data.kind === "run" &&
      record.data.date === l.date
    );
  });
  const pairs = new Map<string, RecordEntry>();
  const moved: HealthLink[] = [];
  const displaced = new Set<string>();
  let savedRuns = 0;
  const fresh = samples.runs.filter((r) => !links.has(runKey(r.start)));
  for (const date of new Set(fresh.map((r) => r.date))) {
    const held = movable.filter((l) => l.date === date);
    const candidates = entered.filter(
      (r) =>
        r.data.kind === "run" &&
        r.data.date === date &&
        (!linkedIds.has(r.id) || held.some((l) => l.recordId === r.id)),
    );
    const today = fresh.filter((r) => r.date === date);
    const result = assignRuns(
      [...held.map((l) => ({ distanceKm: l.distanceKm ?? 0 })), ...today],
      candidates.map((r) => ({
        distanceKm: r.data.kind === "run" ? r.data.distanceKm : 0,
      })),
      held.map((l) => {
        const index = candidates.findIndex((r) => r.id === l.recordId);
        return index >= 0 ? index : null;
      }),
    );
    for (const [i, l] of held.entries()) {
      const j = result[i];
      const record = j === null || j === undefined ? undefined : candidates[j];
      if (record) {
        if (record.id !== l.recordId)
          moved.push({
            ...l,
            recordId: record.id,
            revision: record.revision,
          });
        continue;
      }
      // A closer match took this run's entry: save the Health run itself.
      const saved = await change.save(
        created(
          runSchema.parse({
            kind: "run",
            date: l.date,
            minutes: l.minutes,
            distanceKm: Math.round((l.distanceKm ?? 0) * 1000) / 1000,
            notes: "Apple Health",
          }),
        ),
      );
      if (!saved) throw new Error("Expected the saved run.");
      savedRuns++;
      displaced.add(l.sample);
      moved.push({
        ...l,
        recordId: saved.id,
        matched: false,
        revision: saved.revision,
      });
    }
    today.forEach((run, k) => {
      const j = result[held.length + k];
      const record = j === null || j === undefined ? undefined : candidates[j];
      if (record) pairs.set(run.start, record);
    });
  }
  for (const run of samples.runs) {
    const sample = runKey(run.start);
    const link = links.get(sample);
    if (link && displaced.has(sample)) {
      runs.push({ date: run.date, start: run.start, status: "added" });
      decisions.set(sample, { result: "added", code: "new" });
      continue;
    }
    if (link) {
      runs.push({
        date: run.date,
        start: run.start,
        status: "kept",
        reason: decided(link, "run"),
      });
      decisions.set(sample, earlier(link));
      continue;
    }
    const existing = pairs.get(run.start);
    if (existing) {
      runs.push({
        date: run.date,
        start: run.start,
        status: "kept",
        reason: reasons.run,
      });
      decisions.set(sample, { result: "kept", code: "matched_existing" });
      added.push({
        sample,
        recordId: existing.id,
        date: run.date,
        matched: true,
        revision: existing.revision,
        distanceKm: run.distanceKm,
        minutes: run.minutes,
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
    savedRuns++;
    runs.push({ date: run.date, start: run.start, status: "added" });
    decisions.set(sample, { result: "added", code: "new" });
    added.push({
      sample,
      recordId: saved.id,
      date: run.date,
      matched: false,
      revision: saved.revision,
      distanceKm: run.distanceKm,
      minutes: run.minutes,
    });
  }
  await change.relink(moved);
  await change.link(added);
  return { weights, runs, savedRuns, decisions };
}

/**
 * Saves new weigh-ins and runs from one Health export.
 *
 * Connections with read access get each sample's outcome; write-only
 * connections get the counts they sent, so the reply does not show what the
 * account holds.
 */
export async function importHealth(
  owner: string,
  access: AgentAccess,
  body: unknown,
): Promise<HealthImportReply> {
  return changeHealth(owner, async (change) => {
    const records = await change.records();
    const samples = readHealthExport(body, timezoneOf(records));
    const { weights, runs, savedRuns } = await decide(change, records, samples);
    // Dates and skips depend on the account timezone, so a write-only
    // connection gets only counts taken from its own payload.
    if (!access.read) return { received: samples.sent };
    return {
      added: {
        weights: weights.filter((w) => w.status === "added").length,
        // Includes earlier runs saved after a closer match took their entry.
        runs: savedRuns,
      },
      weights,
      runs,
      skipped: samples.skipped,
      ignored: samples.ignored,
    };
  });
}

/** A backfill grouped its days in another timezone. Nothing was saved. */
class TimezoneChanged extends Error {
  constructor(readonly accountTimezone: string) {
    super(
      "The account timezone changed. Group the samples by day in the account timezone and send them again.",
    );
  }
}

function deviceOutcomes(
  entries: DeviceEntry[],
  decisions: Map<string, Decision>,
): DeviceReply["outcomes"] {
  return entries.flatMap((entry): DeviceReply["outcomes"] => {
    const base = { ref: entry.ref, type: entry.type };
    if (entry.skip) return [{ ...base, result: "skipped", code: entry.skip }];
    if (entry.duplicate)
      return [{ ...base, result: "kept", code: "duplicate_in_request" }];
    const key = entry.at
      ? (entry.type === "weight" ? weightKey : runKey)(entry.at)
      : null;
    const decision = key ? decisions.get(key) : undefined;
    // A missing decision leaves the ref without an outcome, which the reply
    // check reports.
    return decision ? [{ ...base, ...decision }] : [];
  });
}

/**
 * Saves weigh-ins and runs from a device sync request and replies with one
 * outcome per ref. A backfill that names another timezone than the
 * account's fails before anything is saved. `now` fixes the clock in tests.
 */
async function importDeviceHealth(
  key: DeviceKeyClaims,
  body: unknown,
  now = new Date(),
): Promise<DeviceReply> {
  return changeHealth(key.owner, async (change) => {
    // Held until commit, so a disconnect or replacement that has not
    // happened yet waits, and one that has stops this import.
    if (!(await change.holdDeviceKey(key))) throw new DeviceKeyInactive();
    const records = await change.records();
    const timezone = timezoneOf(records);
    const samples = readDeviceExport(body, timezone, localDate(timezone, now));
    if (
      samples.expectedTimezone !== null &&
      samples.expectedTimezone !== timezone
    )
      throw new TimezoneChanged(timezone);
    const { decisions } = await decide(change, records, samples);
    const reply: DeviceReply = {
      kind: "device",
      accountTimezone: timezone,
      outcomes: deviceOutcomes(samples.entries, decisions),
    };
    // Checked before the import commits, so a reply that cannot account for
    // every ref saves nothing.
    checkDeviceReply(samples.entries, reply);
    return reply;
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

const challenge = { "WWW-Authenticate": `Bearer error="invalid_token"` };
function failure(error: string, code: ApiErrorCode, status: number) {
  return json({ error, code }, status, status === 401 ? challenge : {});
}

/** The device key stopped being its installation's active key. Nothing was saved. */
class DeviceKeyInactive extends Error {}

/** A device sync request: strict parsing and one outcome per ref. */
async function deviceImport(
  key: DeviceKeyClaims,
  request: Request,
  now?: Date,
) {
  const text = await readImportBody(request);
  if (text === null)
    return failure(
      "Send up to 4 MB per request. Split the samples across requests.",
      "payload_too_large",
      413,
    );
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return failure("Send the request as JSON.", "invalid_device_request", 400);
  }
  try {
    return json(await importDeviceHealth(key, body, now));
  } catch (error) {
    if (error instanceof HealthImportError)
      return failure(
        error.message,
        error.code ?? "invalid_device_request",
        400,
      );
    if (error instanceof StoreRuleError)
      return failure(error.message, "invalid_device_request", 400);
    if (error instanceof DeviceKeyInactive)
      return failure(
        "This device key is no longer valid. Connect the iPhone again.",
        "key_invalid",
        401,
      );
    if (error instanceof TimezoneChanged)
      return json(
        {
          error: error.message,
          code: "timezone_changed",
          accountTimezone: error.accountTimezone,
        },
        409,
      );
    if (error instanceof BatchConflict)
      return failure(
        "An entry changed while saving. Send the samples again.",
        "import_conflict",
        409,
      );
    console.error("fitness.health.device_import_failed", {
      name: error instanceof Error ? error.name : typeof error,
    });
    return failure(
      "The import could not be saved. Try again.",
      "server_error",
      500,
    );
  }
}

/**
 * POST /api/health/import: one Health export per request, authorized by an
 * API key. Device keys get the device reply; `options.now` fixes the clock
 * for their requests in tests.
 */
export async function handleHealthImport(
  request: Request,
  options: { now?: Date } = {},
) {
  const agent = await authenticateImport(request);
  if (agent.kind === "failed") {
    const { status, error, code } = agent.failure;
    return json(
      code ? { error, code } : { error },
      status,
      status === 401 ? challenge : {},
    );
  }
  if (agent.kind === "device")
    return deviceImport(agent.key, request, options.now);
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
