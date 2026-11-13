import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const chunks = [];
for await (const bytes of process.stdin) chunks.push(bytes);
const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
if (request.schema !== 'shop.fixture-journey-request/v1') throw Error('Unknown journey contract');
const response = await fetch(`${request.origin}/inventory`, { redirect: 'error' });
if (!response.ok) throw Error('Inventory unavailable');
const inventory = await response.json();
if (inventory.complete !== true) throw Error('Incomplete inventory');
const actual = request.phase === 'candidate' ? inventory.versions : inventory.active;
for (const expected of request.components) {
  if (!actual.some(item => item.component === expected.component && item.artifactDigest === expected.artifactDigest && item.configDigest === expected.configDigest)) {
    throw Error('Journey fixture observed a different artifact');
  }
}
// This fixture executes the controller's runner protocol and local HTTP
// identity probe. J01 supplies its own pinned executable and observations.
const evidence = Buffer.from(JSON.stringify({ scope: 'controller-http-fixture', phase: request.phase, inventory }));
const path = 'identity-readback.json';
await writeFile(join(request.evidenceRoot, path), evidence, { mode: 0o600, flag: 'wx' });
const sha256 = createHash('sha256').update(evidence).digest('hex');
process.stdout.write(JSON.stringify({ schema: 'shop.fixture-journey-result/v1', journeyId: request.journeyId, phase: request.phase, compositionDigest: request.compositionDigest,
  nonce: request.nonce, observations: [{ id: 'http-artifact-identity', evidence: { path, bytes: evidence.length, sha256 } }] }));
