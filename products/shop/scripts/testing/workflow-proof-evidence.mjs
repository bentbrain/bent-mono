import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readRegularFile } from '../release-v2/data.mjs';
import { validateProofObservation } from '../release-v2/testing/proof-observations.mjs';
import { sealLinuxEvidence } from './linux-evidence.mjs';
const execute = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');

async function ownedDirectory(path) {
  const info = await lstat(path);
  assert(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o700 && await realpath(path) === path && (typeof process.getuid !== 'function' || info.uid === process.getuid()));
}

// Select structured observations at the two invocation roots only. Original
// streams, configurations, signers, bundles and journals never enter staging.
export async function collectProofObservations(root, output, identity) {
  assert(identity && Object.keys(identity).sort().join(',') === 'attempt,job,repository,runId,sourceCommit');
  assert(identity.repository === 'bentbrain/bent-mono' && /^[a-f0-9]{40}$/.test(identity.sourceCommit) && /^[1-9][0-9]*$/.test(identity.runId) && /^[1-9][0-9]*$/.test(identity.attempt) && /^[a-zA-Z0-9_-]+$/.test(identity.job));
  await ownedDirectory(root); await mkdir(output, { mode:0o700 });
  const selected = [], incomplete = []; let bytes = 0;
  async function collect(directory, prefix) {
    await ownedDirectory(directory);
    for (const name of (await readdir(directory)).sort()) {
      if (!/^[a-z0-9][a-z0-9-]{0,127}-profile\.private\.jsonl$/.test(name)) continue;
      assert(selected.length < 128, 'Proof observation file bound exceeded');
      const original = await readRegularFile(join(directory, name), 2 * 1024 * 1024, true);
      const last = original.lastIndexOf(10), complete = original.subarray(0,last+1), tail = original.subarray(last+1);
      const lines = complete.toString('utf8').split('\n').filter(Boolean);
      for (const line of lines) validateProofObservation(JSON.parse(line));
      // A torn final write stays explicit evidence; it cannot become a valid
      // observation, and its bytes never bypass the strict upload projection.
      if (tail.length) incomplete.push({ path:`${prefix}-${name}`,bytes:tail.length,sha256:hash(tail) });
      const retained = Buffer.from(lines.join('\n') + (lines.length ? '\n' : ''));
      bytes += retained.length; assert(bytes <= 64 * 1024 * 1024, 'Proof observation archive bound exceeded');
      const path = `${prefix}-${name}`; await writeFile(join(output,path),retained,{flag:'wx',mode:0o600});
      selected.push({path,bytes:retained.length,sha256:hash(retained),originalBytes:original.length,originalSha256:hash(original),records:lines.length});
    }
  }
  for (const name of (await readdir(root)).sort()) {
    if (!/^source-integration-[A-Za-z0-9]+$/.test(name)) continue;
    await collect(join(root,name),name);
    try { await lstat(join(root,name,'source-B')); } catch (error) { if(error.code==='ENOENT')continue;throw error; }
    await collect(join(root,name,'source-B'),`${name}-source-B`);
  }
  const manifest = {schema:'shop.workflow-proof-diagnostics/v1',identity,scope:'synthetic-loopback-source-proof',originalStreamsIncluded:false,configurationIncluded:false,keysIncluded:false,files:selected,incomplete};
  await writeFile(join(output,'observations.private.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
  return manifest;
}

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS,'true'); assert.equal(process.env.GITHUB_REPOSITORY,'bentbrain/bent-mono');
  const temporary = process.env.RUNNER_TEMP, job = process.env.GITHUB_JOB;
  assert(typeof temporary==='string' && resolve(temporary)===temporary && /^[a-zA-Z0-9_-]+$/.test(job));
  const root = join(temporary,`shop-workflow-proofs-${job}`), output = join(temporary,`shop-workflow-evidence-${job}`);
  await mkdir(root,{recursive:true,mode:0o700}); await mkdir(output,{mode:0o700});
  const {stdout}=await execute('git',['rev-parse','HEAD']); const sourceCommit=stdout.trim(); assert(/^[a-f0-9]{40}$/.test(sourceCommit));
  const runId=process.env.GITHUB_RUN_ID,attempt=process.env.GITHUB_RUN_ATTEMPT;assert(/^[1-9][0-9]*$/.test(runId)&&/^[1-9][0-9]*$/.test(attempt));
  await collectProofObservations(root,join(output,'observations'),{repository:process.env.GITHUB_REPOSITORY,sourceCommit,runId,attempt,job});
  const archive=join(output,'observations.tar.gz'),sealed=join(output,'sealed');await mkdir(sealed,{mode:0o700});
  try {
    await execute('tar',['-czf',archive,'observations'],{cwd:output,timeout:60000,maxBuffer:65536});
    const recipient=JSON.parse(await readFile(new URL('./linux-evidence-recipient.json',import.meta.url),'utf8'));
    await sealLinuxEvidence(archive,join(sealed,'workflow-proof.tar.gz.enc'),{sourceCommit,runId,filename:'workflow-proof.json'},recipient);
  } finally {await rm(archive,{force:true});}
  console.info('Structured proof observations sealed.');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Proof observation retention failed. Preserve this run before another experiment.');process.exitCode=1;});
