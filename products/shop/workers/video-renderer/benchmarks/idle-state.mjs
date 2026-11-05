export function allContainersStopped(states, lanes) {
  return [2, 4].includes(lanes) && Array.isArray(states) &&
    states.length === lanes && states.every((state) => state?.running === false);
}

export function validIdleProof(family) {
  const proof = family?.idleProof;
  const jobs = family?.jobs;
  return allContainersStopped(proof?.states, family?.lanes) &&
    Array.isArray(jobs) && jobs.length === 4 &&
    jobs.every((job) => Number.isSafeInteger(job?.rendered_at) && job.rendered_at > 0) &&
    Number.isSafeInteger(proof.checkedAt) &&
    proof.checkedAt >= Math.max(...jobs.map((job) => job.rendered_at));
}
