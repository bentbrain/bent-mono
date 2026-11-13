import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { canonical, digest, sha256, check, filesUnder, readRef, parseJSON } from '../data.mjs';
import { captureInputs } from '../../../apps/storefront/scripts/proof-inputs.mjs';

export const retainedEvidence = [
  { id: 'j01-events', path: 'events.json' },
  { id: 'j01-assertions', path: 'startup-proof.json' },
  { id: 'j01-services', path: 'service-identity.json' },
  { id: 'j01-source-inputs', path: 'source-inputs.json' },
];
const requiredOperations = ['built-start-create', 'foreign-owner-draft-and-source-denied', 'direct-editor-gesture', 'editor-reload',
  'sse-first-bytes', 'unready-print-checkout-denied', 'prepared-source-verified', 'stored-image-verified', 'stored-print-verified',
  'sse-complete-and-reconnect', 'stored-video-verified', 'inert-checkout-handoff', 'manual-pause-checkout-denied',
  'wrong-image-callback-denied', 'actual-business-scheduled', 'journey'];

export function journeyEvents(bytes) {
  check(bytes.length <= 16 * 1024 * 1024, 'Actual journey observations exceed byte bound');
  // Browser geometry and native timings include fractional numbers. These
  // retained observations are separate from integer-only admission documents.
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  check(value && Array.isArray(value.events) && Array.isArray(value.blocked), 'Actual journey observation arrays required');
  return value;
}

export async function verifyClosure(identity) {
  check(sha256(await readFile(identity.executable.path)) === identity.executable.sha256, 'Journey service executable changed');
  if (identity.storageGuard) check(sha256(await readFile(identity.storageGuard)) === identity.storageGuardDigest, 'Journey storage guard changed');
  for (const group of identity.groups) {
    if (group.complete) check(canonical(await filesUnder(group.root)) === canonical(group.files.map(file => file.path)), `Journey ${group.name} inventory changed`);
    for (const file of group.files) await readRef(group.root, file);
  }
}

// This service is an explicit trusted local process. Only its restricted HTTP
// client runs under the controller's Node permission and network denial policy.
export async function realJourneyService({ identity, expected, output, checkout, capsule, token, timeoutMs = 115000, fault = () => null }) {
  check(identity.scope === 'inactive-local-real-journey' && identity.awsImageQualified === false, 'Local journey service scope required');
  check(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 115000, 'Journey service timeout exceeds controller bound');
  await verifyClosure(identity);
  await mkdir(output, { mode: 0o700, recursive: true });
  const serviceIdentityDigest = digest(identity), executions = new Map();
  let busy = false;
  const children = new Set();
  const server = createServer(async (request, response) => {
    const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(canonical(value)); };
    try {
      check(request.headers.authorization === `Bearer ${token}` && !request.headers.origin, 'Journey service authorization required');
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && /^\/evidence\/[a-f0-9-]{36}\/\d+$/.test(url.pathname)) {
        const [, , nonce, index] = url.pathname.split('/'), execution = executions.get(nonce);
        check(execution?.receipt && execution.receipt.evidence[Number(index)], 'Unknown retained journey evidence');
        const file = execution.receipt.evidence[Number(index)];
        const bytes = await readRef(execution.directory, file);
        response.writeHead(200, { 'content-type': 'application/octet-stream' }); response.end(bytes); return;
      }
      check(request.method === 'POST' && url.pathname === '/execute', 'Unknown journey service route');
      let size = 0; const chunks = [];
      for await (const chunk of request) { size += chunk.length; check(size <= 65536, 'Journey request exceeds bound'); chunks.push(chunk); }
      const value = parseJSON(Buffer.concat(chunks), 65536);
      check(Object.keys(value).sort().join(',') === Object.keys({ ...expected, nonce: '', phase: '', evidenceRoot: '' }).sort().join(','), 'Journey request fields differ');
      check(/^[a-f0-9-]{36}$/.test(value.nonce) && !executions.has(value.nonce), 'Fresh journey nonce required');
      check(['candidate', 'active'].includes(value.phase), 'Journey phase differs');
      const { nonce, phase, evidenceRoot, ...subject } = value;
      check(canonical(subject) === canonical(expected), 'Journey composition, artifact or input identity differs');
      check(!busy, 'Actual journey service is busy');
      busy = true;
      const directory = join(output, nonce), execution = { directory, receipt: null };
      executions.set(nonce, execution);
      await mkdir(directory, { mode: 0o700 });
      try {
        await verifyClosure(identity);
        await writeFile(join(directory, 'request.private.json'), canonical(value), { mode: 0o600, flag: 'wx' });
        check(!fault(value), 'Injected local journey failure');
        const args = ['run', '--checkout', checkout, '--reserve-gib', '10', '--', identity.executable.path,
          resolve(checkout, 'products/shop/apps/storefront/scripts/local-proof.mjs'), directory, capsule, 'jpeg'];
        const startedAt = Date.now();
        const result = await new Promise((accept, reject) => {
          const child = spawn(identity.storageGuard, args, { cwd: checkout, detached: true, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? '/tmp' }, stdio: ['ignore', 'pipe', 'pipe'] });
          children.add(child);
          let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), overflow = false;
          const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
          const timer = setTimeout(stop, timeoutMs);
          child.stdout.on('data', bytes => { if (stdout.length + bytes.length > 8 * 1024 * 1024) { overflow = true; stop(); } else stdout = Buffer.concat([stdout, bytes]); });
          child.stderr.on('data', bytes => { if (stderr.length + bytes.length > 1024 * 1024) { overflow = true; stop(); } else stderr = Buffer.concat([stderr, bytes]); });
          child.on('error', error => { clearTimeout(timer); children.delete(child); reject(error); });
          child.on('close', (exitCode, signal) => { clearTimeout(timer); children.delete(child); accept({ stdout, stderr, exitCode, signal, overflow }); });
        });
        const run = { schema: 'shop.actual-local-journey-execution/v1', args, executable: identity.executable, guard: identity.storageGuard,
          serviceIdentityDigest, requestDigest: digest(value), nonce, phase, compositionDigest: value.compositionDigest, startedAt, finishedAt: Date.now(),
          exitCode: result.exitCode, signal: result.signal, overflow: result.overflow, stdoutDigest: sha256(result.stdout), stderrDigest: sha256(result.stderr) };
        await writeFile(join(directory, 'service-execution.private.json'), canonical(run), { mode: 0o600 });
        await writeFile(join(directory, 'service-stdout.private.bin'), result.stdout, { mode: 0o600 });
        await writeFile(join(directory, 'service-stderr.private.bin'), result.stderr, { mode: 0o600 });
        check(result.exitCode === 0 && result.signal === null && !result.overflow, 'Actual built customer journey executable failed');
        await verifyClosure(identity);
        check(sha256(await readFile(join(directory, 'business-worker.mjs'))) === identity.businessWorkerDigest, 'Executed business Worker artifact differs');
        const events = journeyEvents(await readFile(join(directory, 'events.json')));
        check(events.blocked.filter(item => !item.boundary).length === 0, 'Unexpected journey outbound request');
        for (const operation of requiredOperations) check(events.events.some(event => event.operation === operation), `Actual journey observation missing: ${operation}`);
        const services = parseJSON(await readFile(join(directory, 'service-identity.json')));
        check(services.nativeBuildId === identity.capsuleManifestDigest && services.lockSha256 === identity.lockDigest, 'Executed capsule or root lock identity differs');
        const inputs = parseJSON(await readFile(join(directory, 'source-inputs.json')), 16 * 1024 * 1024);
        for (const input of inputs.subjects) check(identity.sourceSubjects.some(file => file.path === input.path && file.sha256 === input.sha256 && file.bytes === input.bytes), 'Executed source input differs');
        check(canonical(inputs.subjects) === canonical(identity.sourceSubjects), 'Executed source input inventory differs');
        const after = join(directory, 'after'); await mkdir(after, { mode: 0o700 });
        await captureInputs(checkout, after);
        const afterInputs = parseJSON(await readFile(join(after, 'source-inputs.json')), 16 * 1024 * 1024);
        check(canonical(afterInputs.subjects) === canonical(identity.sourceSubjects), 'Source inventory changed during actual journey');
        const evidence = [];
        for (const item of [...retainedEvidence, { id: 'j01-service-execution', path: 'service-execution.private.json' }]) {
          const bytes = await readFile(join(directory, item.path));
          evidence.push({ ...item, sha256: sha256(bytes), bytes: bytes.length });
        }
        const retained = await Promise.all((await filesUnder(directory)).map(async path => { const bytes = await readFile(join(directory, path)); return { path, sha256: sha256(bytes), bytes: bytes.length }; }));
        await writeFile(join(directory, 'retained-inventory.private.json'), canonical(retained), { mode: 0o600 });
        execution.receipt = { schema: 'shop.actual-local-journey/v1', scope: 'inactive-local-real-journey', providerScope: 'inactive-loopback-simulator', awsImageQualified: false,
          serviceIdentityDigest, nonce, phase, compositionDigest: value.compositionDigest, exitCode: 0, evidence, retainedInventoryDigest: digest(retained) };
        await writeFile(join(directory, 'receipt.private.json'), canonical(execution.receipt), { mode: 0o600 });
        send(200, execution.receipt);
      } finally { busy = false; }
    } catch (error) { send(422, { error: error.message }); }
  });
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  return { origin: `http://127.0.0.1:${server.address().port}`, serviceIdentityDigest, executions,
    close: async () => { for (const child of children) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
      server.closeAllConnections(); await new Promise(accept => server.close(accept)); } };
}
