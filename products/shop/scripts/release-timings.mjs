// Observed durations are not billed minutes. Missing timestamps stay unknown.
export function elapsedMs(start, end) {
  const a = Date.parse(start), b = Date.parse(end);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null;
}
const category = name => {
  if (/checkout|install|setup|set up|cache|prepare (?:pnpm|bun)/i.test(name)) return 'setup';
  if (/qualif/i.test(name)) return 'qualification';
  if (/cleanup/i.test(name)) return 'cleanup';
  if (/check|test|validat|lint/i.test(name)) return 'checks';
  if (/build/i.test(name)) return 'build';
  if (/promot/i.test(name)) return 'promotion';
  if (/deploy|release|native operation/i.test(name)) return 'release';
  return 'other';
};
export function runTimings(run, jobs) {
  const steps = jobs.flatMap(job => (job.steps ?? []).map(step => ({ job: job.name, name: step.name,
    category: category(step.name), conclusion: step.conclusion,
    durationMs: elapsedMs(step.started_at, step.completed_at) })));
  const jobDurations = jobs.map(job => elapsedMs(job.started_at, job.completed_at));
  return { elapsedMs: run.status === 'completed' ? elapsedMs(run.created_at, run.updated_at) : null,
    initialQueueMs: elapsedMs(run.created_at, run.run_started_at),
    observedJobMs: jobDurations.length > 0 && jobDurations.every(value => value !== null)
      ? jobDurations.reduce((sum, value) => sum + value, 0) : null,
    billedRunnerMinutes: null, steps,
    note: 'Job time includes parallel jobs and is not billing data. Combined workflow steps do not expose separate drain, provision or cleanup durations.' };
}
export function timingDistribution(samples) {
  const values = samples.filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const percentile = p => values.length >= 10 ? values[Math.ceil(values.length * p) - 1] : null;
  return { samples: values.length, medianMs: percentile(0.5), p95Ms: percentile(0.95), minimumSamples: 10 };
}
export function coordinatorTimings(journal) {
  return { elapsedMs: elapsedMs(journal.createdAt, journal.stages.at(-1)?.completedAt),
    stages: journal.stages.map(stage => ({ workflow: stage.workflow, operation: stage.inputs.operation ?? 'web',
      runId: stage.runId, dispatchToStartMs: elapsedMs(stage.dispatchedAt, stage.startedAt),
      executionMs: elapsedMs(stage.startedAt, stage.completedAt) })),
    billedRunnerMinutes: null };
}
