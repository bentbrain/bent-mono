import { sealReleaseEvidence } from "./release-evidence.mjs";
import { measureReleaseStage } from "./release-stage-timing.mjs";
import { recoveryReference, readQualificationRun } from "./native-qualification-reference.mjs";
import { isDeepStrictEqual as equal } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { developmentCloudflare } from './native-ci-cloudflare.mjs';
import { createDevelopmentReleaseStore } from './native-ci-release-store.mjs';
import { qualificationIdentity } from './native-qualification-identity.mjs';
import { cleanupDevelopmentQualification } from './native-ci-qualification-cleanup.mjs';
import { verifyRecoverableQualification } from './native-production-qualification.mjs';
const check = (value,reason) => {if(!value) throw Error(`Qualification recovery stopped: ${reason}`);};
export async function writeQualificationPointer(env,reference) {
  check(typeof env.RUNNER_TEMP === 'string' && env.RUNNER_TEMP.startsWith('/'),'runner evidence directory');
  await writeFile(join(env.RUNNER_TEMP,'qualification-reference.json'),sealReleaseEvidence(reference,{sourceCommit:env.GITHUB_SHA,runId:env.GITHUB_RUN_ID,filename:'qualification-reference.json'}),{flag:'wx',mode:0o600});
}
export async function finishQualification(env,cf,store,functional,originalRunId=env.GITHUB_RUN_ID) {
  const originalEnv={...env,GITHUB_RUN_ID:String(originalRunId)};
  const inventory=JSON.parse(await store.read(functional.inventoryReference));
  const cleanup=await measureReleaseStage("qualification-cleanup",()=>cleanupDevelopmentQualification(env,cf,{store,inventory,inventoryReference:functional.inventoryReference,originalEnv}));
  const identity=await qualificationIdentity(cf,store,env);
  check(equal(identity,functional.identity),'Worker, renderer or release identity changed during cleanup');
  const expectedPair={releaseId:functional.releaseId,sourceCommit:functional.sourceCommit,imageDigest:functional.imageDigest};
  const receipt={schemaVersion:1,qualificationComplete:true,expectedPair,identity,
    functionalRunId:Number(originalRunId),functionalReference:functional.evidence,cleanupReference:cleanup.evidence};
  const evidence=await store.save('qualification-receipt.json',Buffer.from(JSON.stringify(receipt)));
  await writeFile(join(env.RUNNER_TEMP,'qualification-completion-reference.json'),sealReleaseEvidence(evidence,{sourceCommit:env.GITHUB_SHA,runId:env.GITHUB_RUN_ID,filename:'qualification-completion-reference.json'}),{flag:'wx',mode:0o600});
  if (functional.rendererEvidence && functional.baselineSelectionEligible !== false) await writeFile(join(env.RUNNER_TEMP,'renderer-reference.json'),sealReleaseEvidence({schemaVersion:1,
    reference:evidence,expectedPair,sourceCommit:env.GITHUB_SHA,inputsDigest:functional.rendererEvidence.inputsDigest,
    nodeVersion:functional.rendererEvidence.nodeVersion, ...(functional.rendererEvidence.boundary ? {boundary:functional.rendererEvidence.boundary} : {})},{sourceCommit:env.GITHUB_SHA,runId:env.GITHUB_RUN_ID,filename:'renderer-reference.json'}),{flag:'wx',mode:0o600});
  return {...receipt,evidence};
}
export async function recoverQualification(env) {
  const {reference,runId}=recoveryReference(env.NATIVE_QUALIFICATION_REFERENCE,env.NATIVE_VERIFY_RELEASE);
  check(String(runId) !== env.GITHUB_RUN_ID,'recovery requires a separate run');
  const cf=developmentCloudflare(env),store=await createDevelopmentReleaseStore(env);
  const identity=await qualificationIdentity(cf,store,env);
  const expectedPair={releaseId:identity.releaseId,sourceCommit:identity.sourceCommit,imageDigest:identity.imageDigest};
  const verified=await verifyRecoverableQualification({reference,expectedPair,expectedQualificationCommit:env.GITHUB_SHA,
    githubRun:await readQualificationRun(env,runId),readObject:store.read,readRun:id=>readQualificationRun(env,id)});
  check(equal(identity,verified.summary.identity),'original immutable Worker and renderer identity');
  return finishQualification(env,cf,store,{...verified.summary,evidence:reference},runId);
}
