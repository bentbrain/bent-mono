import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseMeasurements } from './release-measurements.mjs';
import { measureReleaseStage } from './release-stage-timing.mjs';
const journal=(id,cacheState='warm')=>({schemaVersion:1,repository:'bentbrain/bent-mono',id:String(id),source:'a'.repeat(40),target:'preview',mode:'full',cacheState,
 createdAt:'2026-09-11T01:00:00Z',stages:[{status:'complete',completedAt:`2026-09-11T01:20:${String(id).padStart(2,'0')}Z`}]});
test('ten comparable releases are needed; cache states and recoveries cannot be pooled',()=>{
 const samples=Array.from({length:10},(_,i)=>journal(i));
 assert.equal(releaseMeasurements(samples.slice(0,9)).groups[0].medianMs,null);
 const result=releaseMeasurements([...samples,journal(10,'cold')]);
 assert.equal(result.groups[0].medianMs,1204000);assert.equal(result.groups[0].p95Ms,1209000);
 assert.equal(result.groups[1].medianMs,null);assert.equal(result.billedRunnerMinutes,null);
 assert.throws(()=>releaseMeasurements([samples[0],samples[0]]));
 samples[0].stages[0].recovery={};assert.equal(releaseMeasurements(samples).groups.every(group=>group.medianMs===null),true);
});
test('stage timing retains successful or failed outcomes and never retries the operation',async()=>{
 const events=[],write=async event=>events.push(event);let calls=0,tick=0;
 const options={write,now:()=>tick+=10,id:'test'};
 assert.equal(await measureReleaseStage('drain',async()=>{calls++;return 7;},options),7);
 await assert.rejects(measureReleaseStage('cleanup',async()=>{calls++;throw Error('uncertain');},options));
 assert.equal(calls,2);assert.equal(events.length,4);
 assert.equal(events[1].conclusion,'success');assert.equal(events[3].conclusion,'failure');assert.equal(events[1].durationMs,10);
});


test('the ten-minute target measures Preview through Production, including qualification and review gaps',()=>{
 const preview={...journal(1),policyVersion:3,selection:{components:{api:true},routineTargetMs:600000},createdAt:'2026-10-11T10:00:00Z',stages:[{status:'complete',completedAt:'2026-10-11T10:03:00Z'}]};
 const production={...preview,id:'production',target:'production',createdAt:'2026-10-11T10:07:00Z',stages:[{status:'complete',completedAt:'2026-10-11T10:11:00Z'}]};
 const measured=releaseMeasurements([preview,production]).journeys[0];
 assert.equal(measured.elapsedMs,660000);assert.equal(measured.withinTarget,false);
 assert.equal(releaseMeasurements([production]).journeys[0].withinTarget,null);
 assert.equal(releaseMeasurements([preview,{...production,stages:[{status:'dispatched'}]}]).journeys[0].withinTarget,null);
});

test('native journey timing binds the promoted release and browser, retaining incomplete or ambiguous lineage',()=>{
 const source='a'.repeat(40), selection={components:{api:true},routineTargetMs:600000};
 const preview=(id,runId,browserId,status='complete')=>({...journal(id),source,policyVersion:3,selection,
  createdAt:'2026-10-11T10:00:00Z',stages:[
   {workflow:'native-development.yml',inputs:{operation:'release'},runId,status:'complete',completedAt:'2026-10-11T10:02:00Z'},
   {workflow:'preview-smoke.yml',runId:browserId,status,completedAt:status==='complete'?'2026-10-11T10:03:00Z':undefined}]});
 const older=preview(1,111,112),accepted=preview(2,222,223);
 const production={...journal(3),source,policyVersion:3,target:'production',createdAt:'2026-10-11T10:04:00Z',
  promotion:{qualification:{expectedPair:{releaseId:'native-222',sourceCommit:source,imageDigest:'image'}},
   acceptance:{developmentReleaseId:'native-222',sourceCommit:source,imageDigest:'image',previewRunId:223}},
  stages:[{workflow:'native-production.yml',status:'complete',completedAt:'2026-10-11T10:08:00Z'}]};
 const measure=previews=>releaseMeasurements([...previews,production]);
 assert.equal(measure([older,accepted]).journeys[0].previewJournalId,'2');
 assert.equal(measure([older,accepted]).journeys[0].withinTarget,true);
 for(const candidates of [[older],[older,preview(2,222,223,'failed')],[older,preview(2,222,224)],
  [accepted,{...accepted,id:'duplicate'}],[{...accepted,source:'b'.repeat(40)}],
  [{...accepted,stages:accepted.stages.map(stage=>({...stage,completedAt:'2026-10-11T10:05:00Z'}))}]]) {
  const result=measure(candidates);
  assert.equal(result.journeys[0].previewJournalId,null);
  assert.equal(result.journeys[0].withinTarget,null);
  assert.equal(result.reviews[0].reviewAndCoordinationMs,null);
 }
 assert.equal(releaseMeasurements([older,{...production,promotion:undefined}]).journeys[0].withinTarget,null);
 assert.equal(releaseMeasurements([accepted,{...production,promotion:{...production.promotion,
  acceptance:{...production.promotion.acceptance,developmentReleaseId:'native-111'}}}]).journeys[0].withinTarget,null);
});
