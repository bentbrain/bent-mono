import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { recordedProcess } from './release-v2/testing/workflow-journey-fixture.mjs';
import { validateProofObservation } from './release-v2/testing/proof-observations.mjs';
import { collectProofObservations } from './testing/workflow-proof-evidence.mjs';

async function root(t) { const path=await realpath(await mkdtemp(join(tmpdir(),'workflow-observations-')));t.after(()=>rm(path,{recursive:true,force:true}));return path; }
const checkout=fileURLToPath(new URL('../../../',import.meta.url)).replace(/\/$/,'');
const identity={repository:'bentbrain/bent-mono',sourceCommit:'a'.repeat(40),runId:'1',attempt:'1',job:'check'};

// Exercise the original implementation through the identical exported callsite
// when capturing the retained red proof; the normal suite always uses source.
async function implementation(output) {
  if (process.env.SHOP_CAPTURE_ORIGINAL_PROOF !== '1') return recordedProcess;
  const original=execFileSync('git',['show','05fab3dbeb0e171149f3efa995a3ec6e9b83fa56:products/shop/scripts/release-v2/testing/workflow-journey-fixture.mjs'],{encoding:'utf8'});
  const start=original.indexOf('export async function recordedProcess('),end=original.indexOf('\nexport function syntheticRetainedRunner()',start);
  const module=join(output,'original.private.mjs');
  const imports=`import {spawn} from 'node:child_process';import {dirname,join} from 'node:path';import {readFile,writeFile} from 'node:fs/promises';import {check,sha256,canonical} from ${JSON.stringify(new URL('./release-v2/data.mjs',import.meta.url).href)};import {privateProofDirectory} from ${JSON.stringify(new URL('./release-v2/testing/workflow-journey-fixture.mjs',import.meta.url).href)};const checkout=${JSON.stringify(process.cwd())};\n`;
  await writeFile(module,imports+original.slice(start,end),{mode:0o600});
  return (await import(pathToFileURL(module).href)).recordedProcess;
}

test('outer cancellation streams diagnostics and confirms the entire proof process group exited', async t=>{
  const output=await root(t),run=await implementation(output),abort=new AbortController();
  const promise=run({output,name:'outer-abort',timeoutMs:3000,signal:abort.signal,args:['--input-type=module','-e',
    "import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write(JSON.stringify({grandchild:child.pid})+'\\n');setInterval(()=>{},1000);"]});
  let retained=false;
  try {
    for(let i=0;i<100&&!retained;i++){
      await new Promise(resolve=>setTimeout(resolve,10));
      try{retained=(await readFile(join(output,'outer-abort-stdout.private.bin'),'utf8')).includes('grandchild');}catch(error){if(error.code!=='ENOENT')throw error;}
    }
  }finally{abort.abort();}
  const result=await promise;
  assert.equal(retained,true,'Original stream must be retained before process close');
  assert.equal(result.aborted,true);assert.equal(result.timedOut,false);assert.equal(result.reaped,true);assert.equal(result.signal,'SIGKILL');
  const rows=(await readFile(join(output,result.profile),'utf8')).trim().split('\n').map(line=>validateProofObservation(JSON.parse(line)));
  const end=rows.at(-1);assert.equal(end.kind,'close');assert.equal(end.details.reaped,true);assert.deepEqual(end.details.remainingPids,[]);
  const {grandchild}=JSON.parse(result.stdoutText);assert.throws(()=>process.kill(grandchild,0),{code:'ESRCH'});
});

test('structured exporter retains measured observations and excludes raw configuration, keys and streams',async t=>{
  const directory=await root(t),input=join(directory,'input');await mkdir(input,{mode:0o700});const invocation=join(input,'source-integration-abcdef');await mkdir(invocation,{mode:0o700});
  const value={schema:'shop.workflow-proof-observation/v1',invocation:'advance-000',at:1,kind:'child',details:{step:'controller-start',command:'advance',phase:'',metrics:{hashCalls:4,hashBytes:100,readCalls:2,readBytes:50,httpRequests:3,cacheHits:2}}};
  await writeFile(join(invocation,'advance-000-profile.private.jsonl'),JSON.stringify(value)+'\n',{mode:0o600});
  for(const name of ['advance-000-configuration.private.json','source.pem','advance-000-stdout.private.bin'])await writeFile(join(invocation,name),'SECRET_SENTINEL',{mode:0o600});
  const output=join(directory,'retained'),manifest=await collectProofObservations(input,output,identity);
  assert.equal(manifest.files.length,1);assert(!JSON.stringify(manifest).includes('SECRET_SENTINEL'));
  assert.deepEqual(JSON.parse(await readFile(join(output,manifest.files[0].path),'utf8')),value);
  await assert.rejects(collectProofObservations(input,join(directory,'invalid-identity'),{...identity,privateKey:'SECRET_SENTINEL'}));
  await writeFile(join(invocation,'advance-001-profile.private.jsonl'),JSON.stringify({...value,details:{...value.details,configuration:'SECRET_SENTINEL'}})+'\n',{mode:0o600});
  await assert.rejects(collectProofObservations(input,join(directory,'invalid-profile'),identity));
});

test('torn observation tails remain explicitly hashed incomplete evidence',async t=>{
  const directory=await root(t),input=join(directory,'input'),invocation=join(input,'source-integration-abcdef');await mkdir(invocation,{recursive:true,mode:0o700});
  await writeFile(join(invocation,'advance-000-profile.private.jsonl'),'{"torn":',{mode:0o600});
  const result=await collectProofObservations(input,join(directory,'retained'),identity);assert.equal(result.incomplete.length,1);assert.equal(result.incomplete[0].bytes,8);assert.equal(result.files[0].records,0);
});

test('Node test timeout propagates its real AbortSignal and retains a completed cleanup record',async t=>{
  const output=await root(t),inner=join(output,'inner');await privateProofDirectoryForTest(inner);
  const module=join(output,'cancelled.test.mjs');
  await writeFile(module,`import test from 'node:test';import {recordedProcess} from ${JSON.stringify(new URL('./release-v2/testing/workflow-journey-fixture.mjs',import.meta.url).href)};
test('forced outer cancellation',{timeout:1000},async t=>{const pending=recordedProcess({output:${JSON.stringify(inner)},name:'cancelled-child',signal:t.signal,timeoutMs:3500,args:['-e','process.stdout.write("ready\\\\n");setInterval(()=>{},1000)']});t.after(async()=>{await pending;});await pending;});`,{mode:0o600});
  const process=await recordedProcess({output,name:'outer-test',timeoutMs:8000,args:['--test',module]});
  assert.equal(process.exitCode,1);assert.equal(process.timedOut,false);assert.equal(process.reaped,true);
  const rows=(await readFile(join(inner,'cancelled-child-profile.private.jsonl'),'utf8')).trim().split('\n').map(line=>validateProofObservation(JSON.parse(line)));
  const end=rows.at(-1);assert.equal(end.kind,'close',process.stdoutText + process.stderrText + JSON.stringify(rows));assert.equal(end.details.aborted,true);assert.equal(end.details.timedOut,false);assert.equal(end.details.reaped,true);assert.deepEqual(end.details.remainingPids,[]);
});

async function privateProofDirectoryForTest(path) {await mkdir(path,{mode:0o700});}

test('hosted observation command seals only the validated projection with the public recipient',async t=>{
  const directory=await root(t),job='diagnostic',input=join(directory,`shop-workflow-proofs-${job}`),invocation=join(input,'source-integration-abcdef');
  await mkdir(invocation,{recursive:true,mode:0o700});
  const value={schema:'shop.workflow-proof-observation/v1',invocation:'source-proof',at:1,kind:'child',details:{step:'fixture-start',command:'',phase:'',metrics:{userCpuUs:1}}};
  await writeFile(join(invocation,'source-proof-profile.private.jsonl'),JSON.stringify(value)+'\n',{mode:0o600});
  await writeFile(join(invocation,'source.pem'),'SECRET_SENTINEL',{mode:0o600});
  const result=await recordedProcess({output:directory,name:'seal-observations',args:[new URL('./testing/workflow-proof-evidence.mjs',import.meta.url).pathname],env:observationEnvironment(directory)});
  assert.equal(result.exitCode,0,result.stderrText);
  const archive=join(directory,`shop-workflow-evidence-${job}`,'sealed','workflow-proof.tar.gz.enc');
  const encrypted=await readFile(archive),envelope=JSON.parse(await readFile(`${archive}.envelope.json`,'utf8'));
  assert(encrypted.length>0);assert.equal(encrypted.includes(Buffer.from('SECRET_SENTINEL')),false);
  assert.equal(envelope.identity.filename,'workflow-proof.json');assert.equal(envelope.identity.runId,'1');
  const manifest=JSON.parse(await readFile(join(directory,`shop-workflow-evidence-${job}`,'observations','observations.private.json'),'utf8'));
  assert.equal(manifest.files.length,1);assert.equal(manifest.files[0].records,1);assert.equal(manifest.keysIncluded,false);
});

function observationEnvironment(directory, { trusted=true, path='/usr/bin:/bin' }={}) {
  return { PATH:path,GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:identity.repository,GITHUB_JOB:'diagnostic',RUNNER_TEMP:directory,GITHUB_RUN_ID:'1',GITHUB_RUN_ATTEMPT:'1',
    GIT_TEST_ASSUME_DIFFERENT_OWNER:'1',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',
    ...(trusted?{GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'safe.directory',GIT_CONFIG_VALUE_0:checkout}:{}) };
}
async function observationInput(t, malformed=false) {
  const directory=await root(t),input=join(directory,'shop-workflow-proofs-diagnostic','source-integration-abcdef');
  await mkdir(input,{recursive:true,mode:0o700});
  const value={schema:'shop.workflow-proof-observation/v1',invocation:'source-proof',at:1,kind:'child',details:{step:'fixture-start',command:'',phase:'',metrics:{userCpuUs:1},...(malformed?{configuration:'SECRET_SENTINEL'}:{})}};
  await writeFile(join(input,'source-proof-profile.private.jsonl'),JSON.stringify(value)+'\n',{mode:0o600});
  return directory;
}
for (const [name,trusted,malformed,stage] of [['missing exact-checkout trust',false,false,'git-head'],['malformed observation',true,true,'projection']]) {
  test(`observation command identifies ${name} without exposing rejected data`,async t=>{
    const directory=await observationInput(t,malformed);
    const result=await recordedProcess({output:directory,name:'seal-rejection',args:[new URL('./testing/workflow-proof-evidence.mjs',import.meta.url).pathname],env:observationEnvironment(directory,{trusted})});
    assert.equal(result.exitCode,1);assert.equal(result.stdoutText,'');
    assert.equal(result.stderrText,`Proof observation retention failed during ${stage}. Preserve this run before another experiment.\n`);
    for(const secret of ['SECRET_SENTINEL',directory,checkout,'dubious ownership'])assert.equal(result.stderrText.includes(secret),false);
  });
}

test('observation cleanup preserves the original archive failure stage',async t=>{
  const directory=await observationInput(t),bin=join(directory,'bin');await mkdir(bin,{mode:0o700});
  await writeFile(join(bin,'tar'),`#!${process.execPath}\nimport {mkdirSync} from 'node:fs';mkdirSync(process.argv[3]);process.exitCode=23;\n`,{mode:0o700});
  const result=await recordedProcess({output:directory,name:'archive-rejection',args:[new URL('./testing/workflow-proof-evidence.mjs',import.meta.url).pathname],env:observationEnvironment(directory,{path:`${bin}:/usr/bin:/bin`})});
  assert.equal(result.exitCode,1);assert.equal(result.stderrText,'Proof observation retention failed during archive. Preserve this run before another experiment.\n');
});
