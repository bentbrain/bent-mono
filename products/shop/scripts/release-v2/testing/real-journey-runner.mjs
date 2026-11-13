import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// The integration driver replaces this with private, independently pinned
// service configuration before the controller admits the runner bytes.
const integration = /* private integration configuration */ null;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
if (!integration || request.schema !== 'shop.fixture-journey-request/v1') throw Error('Journey integration configuration required');
if (!request.allowedOrigins.includes(integration.origin)) throw Error('Journey service origin is not admitted');
const inventoryResponse = await fetch(`${request.origin}/inventory`, { redirect: 'error' });
if (!inventoryResponse.ok) throw Error('Fixture provider inventory unavailable');
const inventory = await inventoryResponse.json();
if (inventory.complete !== true) throw Error('Incomplete fixture provider inventory');
const actual = request.phase === 'candidate' ? inventory.versions : inventory.active;
for (const expected of request.components) {
  if (!actual.some(item => item.component === expected.component && item.artifactDigest === expected.artifactDigest && item.configDigest === expected.configDigest)) {
    throw Error('Journey observed different fixture provider artifacts');
  }
}
const response = await fetch(`${integration.origin}/execute`, {
  method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${integration.token}`, 'content-type': 'application/json' }, body: JSON.stringify(request),
});
if (!response.ok) throw Error(`Actual local journey failed, HTTP ${response.status}, ${await response.text()}`);
const receipt = await response.json();
if (receipt.schema !== 'shop.actual-local-journey/v1' || receipt.compositionDigest !== request.compositionDigest || receipt.nonce !== request.nonce ||
    receipt.phase !== request.phase || receipt.serviceIdentityDigest !== integration.serviceIdentityDigest || receipt.exitCode !== 0) throw Error('Actual journey receipt subject differs');
const observations = [];
for (const [index, expected] of receipt.evidence.entries()) {
  const evidenceResponse = await fetch(`${integration.origin}/evidence/${request.nonce}/${index}`, {
    redirect: 'error', headers: { authorization: `Bearer ${integration.token}` },
  });
  if (!evidenceResponse.ok) throw Error('Actual journey evidence unavailable');
  const bytes = Buffer.from(await evidenceResponse.arrayBuffer());
  if (bytes.length !== expected.bytes || hash(bytes) !== expected.sha256) throw Error('Actual journey evidence bytes differ');
  await writeFile(join(request.evidenceRoot, `retained-${index}.bin`), bytes, { mode: 0o600, flag: 'wx' });
}
const bytes = Buffer.from(JSON.stringify({ request, receipt, providerScope: 'inactive-loopback-simulator', inventory }));
const path = 'actual-journey.json';
await writeFile(join(request.evidenceRoot, path), bytes, { mode: 0o600, flag: 'wx' });
observations.push({ id: 'j01-built-customer-journey', evidence: { path, sha256: hash(bytes), bytes: bytes.length } });
// Each downloaded file is independently checked by the controller too.
for (const [index, expected] of receipt.evidence.entries()) observations.push({ id: expected.id,
  evidence: { path: `retained-${index}.bin`, sha256: expected.sha256, bytes: expected.bytes } });
process.stdout.write(JSON.stringify({ schema: 'shop.fixture-journey-result/v1', journeyId: request.journeyId, phase: request.phase,
  compositionDigest: request.compositionDigest, nonce: request.nonce, observations }));
