import { check } from './runtime/contract.mjs';

export function platformReport(log, requestId) {
  check(/^[a-f0-9-]{36}$/.test(requestId ?? ''), 'AWS request identifier');
  const lines = log.split('\n').filter(line => line.startsWith(`REPORT RequestId: ${requestId}\t`));
  check(lines.length === 1, 'matching AWS REPORT line');
  const metric = label => {
    const match = new RegExp(`\\t${label}: ([0-9.]+)`).exec(lines[0]);
    const number = match ? Number(match[1]) : null;
    check(number === null || (Number.isFinite(number) && number >= 0), 'finite platform metric'); return number;
  };
  const result = { durationMs: metric('Duration'), billedMs: metric('Billed Duration'), initMs: metric('Init Duration'), maxMemoryMB: metric('Max Memory Used') };
  check(result.durationMs !== null && result.billedMs !== null && result.maxMemoryMB !== null, 'complete AWS REPORT evidence');
  return result;
}

export async function settledPair(invoke) {
  const outcomes = await Promise.allSettled([invoke(), invoke()]);
  const failed = outcomes.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  return outcomes.map(result => result.value);
}
