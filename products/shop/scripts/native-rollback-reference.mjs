const check = (value, reason) => { if (!value) throw Error(`Paused rollback recovery stopped: ${reason}`); };
export function rollbackRecoveryReference(value, releaseId) {
  check(typeof value === 'string' && value.length <= 4096, 'bounded immutable rollback reference required');
  const reference = JSON.parse(value);
  check(/^native-[1-9][0-9]*$/.test(releaseId ?? '') && reference.key === `source/releases/${releaseId}/rollback.json` &&
    /^[a-f0-9]{64}$/.test(reference.sha256 ?? '') && typeof reference.version === 'string' &&
    /^[a-zA-Z0-9._~+/=-]{1,1024}$/.test(reference.version) && reference.version !== 'null', 'exact original rollback evidence required');
  return reference;
}

