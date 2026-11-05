const check = (value, reason) => {
  if (!value) throw new Error(`Release timing inspection failed: ${reason}`);
};

export function summarizeReleaseEvents(records) {
  check(Array.isArray(records) && records.length > 0 && records.length < 64, "bounded release event history.");
  const seen = new Set();
  for (const record of records) {
    check(typeof record.stage === "string" && /^[a-z][a-z-]{0,39}$/.test(record.stage) && !seen.has(record.stage) &&
      Number.isSafeInteger(record.created_at) && record.created_at >= 0, "unique release stages and timestamps.");
    seen.add(record.stage);
  }
  for (let index = 1; index < records.length; index += 1) {
    check(records[index].created_at >= records[index - 1].created_at, "chronological release events.");
  }
  const stages = records.map((record, index) => ({
    stage: record.stage,
    createdAt: record.created_at,
    durationMs: index + 1 < records.length ? records[index + 1].created_at - record.created_at : null,
  }));
  return {
    firstStageAt: records[0].created_at,
    lastStageAt: records.at(-1).created_at,
    totalMs: records.at(-1).created_at - records[0].created_at,
    stages,
  };
}
