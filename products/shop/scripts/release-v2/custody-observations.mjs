import { check, digest, parseJSON, readRef, same } from './data.mjs';
import { assertPolicy, assetManifest, exactFields } from './provider-protocol-builders.mjs';
import { responseBytes } from './provider-protocol.mjs';

export function createWorkObserver({ policy, client }) {
  assertPolicy(policy); check(policy.workInventory && client?.builders && typeof client.send === 'function', 'Admitted complete accepted-work database adapter required');
  return async () => {
    const jobs = [];
    for (let index = 0; index < policy.workInventory.queries.length; index++) {
      const response = await client.send(client.builders.workQuery(index));
      check(response.status === 200, 'Accepted-work database query failed');
      const value = parseJSON(responseBytes(response));
      check(value.success === true && Array.isArray(value.result) && value.result.length === 1 && (!value.errors || value.errors.length === 0), 'Complete accepted-work database response required');
      const result = value.result[0];
      check(result.success === true && Array.isArray(result.results) && result.results.length < 4096 && !result.next_page && !result.truncated && !result.error, 'Accepted-work query is incomplete or exceeds bound');
      for (const row of result.results) {
        exactFields(row, ['artifactDigest', 'format']);
        check(/^[a-f0-9]{64}$/.test(row.artifactDigest) && typeof row.format === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(row.format), 'Accepted-work artifact/format identity differs');
        jobs.push({ component: policy.workInventory.queries[index].component, ...row });
      }
      check(jobs.length <= 4096, 'Accepted-work inventory exceeds bound');
    }
    return { complete: true, queryDigest: digest(policy.workInventory), jobs };
  };
}

export function createRetainedAssetResolver({ bundle, entries }) {
  check(typeof bundle === 'string' && Array.isArray(entries) && entries.length <= 32 && new Set(entries.map(entry => entry.resource)).size === entries.length, 'Complete retained custody asset catalog required');
  for (const entry of entries) { exactFields(entry, ['resource', 'manifestDigest', 'assets']); check(/^[a-z][a-z0-9-]{0,62}$/.test(entry.resource) && /^[a-f0-9]{64}$/.test(entry.manifestDigest) && Array.isArray(entry.assets) && entry.assets.length > 0, 'Exact retained asset subject required'); }
  return async ({ resource, manifestDigest }) => {
    const entry = entries.find(item => item.resource === resource); check(entry && (!manifestDigest || entry.manifestDigest === manifestDigest), 'Admitted exact custody asset catalog is missing');
    const assets = [];
    for (const part of entry.assets) { exactFields(part, ['name', 'type', 'ref']); assets.push({ path: part.name, type: part.type, bytes: await readRef(bundle, part.ref) }); }
    check(digest(assetManifest(assets).manifest) === entry.manifestDigest, 'Retained custody assets differ from complete admitted manifest'); return assets;
  };
}
