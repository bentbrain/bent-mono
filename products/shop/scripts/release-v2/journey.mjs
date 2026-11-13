import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { canonical, check, digest, parseJSON, readRef, confined, sha256 } from './data.mjs';
import { loopbackOrigin } from './provider.mjs';
import { subject, allInputs } from './composition.mjs';
import { selectedVersion } from './component-identity.mjs';

export async function journey({ bundle, directory, admission, origin, phase }) {
  const { trust, compositionDigest, payload } = admission, runner = trust.runner;
  const hosted = trust.schema === 'shop.hosted-composition-policy/v1' && trust.scope === 'isolated-qualification';
  const scope = hosted ? 'isolated-qualification' : 'inactive-local';
  check(hosted || trust.scope === 'inactive-loopback', 'Journey trust domain differs');
  const approvedOrigin = value => {
    if (!hosted) return loopbackOrigin(value);
    check(typeof value === 'string' && /^https:\/\/[a-z0-9][a-z0-9.-]+$/.test(value) && new URL(value).origin === value, 'Exact qualification HTTPS origin required');
    return value;
  };
  if (hosted) check(runner.origins.includes(approvedOrigin(origin)), 'Journey origin is outside protected admission');
  const script = await confined(bundle, runner.script.path);
  await readRef(bundle, runner.script);
  check(sha256(await readFile(process.execPath)) === runner.executableDigest, 'Journey executable changed');
  const nonce = randomUUID(), evidenceRoot = resolve(directory, 'evidence', nonce);
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  const request = { schema: hosted ? 'shop.hosted-journey-request/v1' : 'shop.fixture-journey-request/v1', journeyId: runner.id, phase, compositionDigest, subjectDigest: subject(payload),
    inputsDigest: allInputs(payload), intentSourceCommit: payload.intentSourceCommit, baseCommit: payload.baseCommit, nonce, origin, evidenceRoot,
    allowedOrigins: [...new Set([origin, ...runner.origins.map(approvedOrigin)])],
    components: payload.components.map(component => ({ component: component.id, artifactDigest: selectedVersion(component).artifactDigest, configDigest: component.config.sha256,
      artifact: component.artifact, config: component.config, provenance: component.provenance, originSourceCommit: component.originSourceCommit,
      inputsDigest: component.inputsDigest, intentInputsDigest: component.intentInputsDigest })) };
  const startedAt = Date.now();
  const denial = fileURLToPath(new URL(hosted ? './qualification-network.mjs' : './network-deny.mjs', import.meta.url));
  const args = ['--permission', `--allow-fs-read=${bundle}`, `--allow-fs-read=${dirname(denial)}`, `--allow-fs-write=${evidenceRoot}`, '--import', denial, script];
  const result = await new Promise(accept => {
    const child = spawn(process.execPath, args, { cwd: bundle, env: { PATH: dirname(process.execPath),
      [hosted ? 'SHOP_QUALIFICATION_ORIGINS' : 'SHOP_FIXTURE_ORIGINS']: canonical(request.allowedOrigins) }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), overflow = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), runner.timeoutMs);
    child.stdout.on('data', bytes => { if (stdout.length + bytes.length > 1024 * 1024) { overflow = true; child.kill('SIGKILL'); } else stdout = Buffer.concat([stdout, bytes]); });
    child.stderr.on('data', bytes => { if (stderr.length + bytes.length > 65536) { overflow = true; child.kill('SIGKILL'); } else stderr = Buffer.concat([stderr, bytes]); });
    child.on('error', error => { clearTimeout(timer); accept({ stdout, stderr, exitCode: null, signal: null, overflow, spawnError: error.code ?? 'unknown' }); });
    child.on('close', (exitCode, signal) => { clearTimeout(timer); accept({ stdout, stderr, exitCode, signal, overflow }); });
    child.stdin.on('error', () => {});
    child.stdin.end(canonical(request));
  });
  const finishedAt = Date.now();
  const execution = { schema: 'shop.executed-journey-process/v1', scope, journeyId: runner.id, compositionDigest, phase, nonce,
    executableDigest: runner.executableDigest, scriptDigest: runner.script.sha256, args, requestDigest: digest(request),
    exitCode: result.exitCode, signal: result.signal, spawnError: result.spawnError ?? null, overflow: result.overflow, stdoutDigest: sha256(result.stdout), stderrDigest: sha256(result.stderr), startedAt, finishedAt };
  await writeFile(resolve(evidenceRoot, 'execution.json'), canonical(execution), { flag: 'wx', mode: 0o600 });
  await writeFile(resolve(evidenceRoot, 'stdout.bin'), result.stdout, { flag: 'wx', mode: 0o600 });
  await writeFile(resolve(evidenceRoot, 'stderr.bin'), result.stderr, { flag: 'wx', mode: 0o600 });
  check(!result.overflow && result.exitCode === 0 && result.signal === null, `Journey executable failed, exit ${result.exitCode}, signal ${result.signal ?? 'none'}, stderr digest ${sha256(result.stderr)}`);
  const receipt = parseJSON(result.stdout);
  check(receipt && Object.keys(receipt).sort().join(',') === 'compositionDigest,journeyId,nonce,observations,phase,schema' && receipt.schema === (hosted ? 'shop.hosted-journey-result/v1' : 'shop.fixture-journey-result/v1') &&
    receipt.journeyId === runner.id && receipt.compositionDigest === compositionDigest && receipt.nonce === nonce && receipt.phase === phase && Array.isArray(receipt.observations), 'Journey executable receipt differs');
  check(new Set(receipt.observations.map(item => item.id)).size === receipt.observations.length &&
    canonical(receipt.observations.map(item => item.id).sort()) === canonical([...runner.requiredObservations].sort()), 'Required journey observations missing');
  for (const observation of receipt.observations) {
    check(Object.keys(observation).sort().join(',') === 'evidence,id' && observation.evidence &&
      Object.keys(observation.evidence).sort().join(',') === 'bytes,path,sha256' && Number.isSafeInteger(observation.evidence.bytes) &&
      observation.evidence.bytes > 0 && /^[a-f0-9]{64}$/.test(observation.evidence.sha256), 'Malformed journey evidence subject');
    await readRef(evidenceRoot, observation.evidence);
  }
  await readRef(bundle, runner.script);
  check(sha256(await readFile(process.execPath)) === runner.executableDigest, 'Journey executable changed during execution');
  return { schema: 'shop.executed-journey/v1', scope, journeyId: runner.id, phase, compositionDigest, executableDigest: runner.executableDigest,
    scriptDigest: runner.script.sha256, invocationDigest: digest(args), exitCode: result.exitCode, stdoutDigest: sha256(result.stdout),
    stderrDigest: sha256(result.stderr), startedAt, finishedAt, evidenceRoot, executionDigest: digest(execution), observations: receipt.observations };
}
