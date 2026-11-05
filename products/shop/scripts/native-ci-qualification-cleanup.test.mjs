import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupDevelopmentQualification,
  ensureDevelopmentStorageLifecycle,
} from "./native-ci-qualification-cleanup.mjs";

const MANAGED_RULE = {
  id: "expire-development-benchmarks-after-seven-days",
  conditions: { prefix: "benchmarks/" },
  enabled: true,
  deleteObjectsTransition: {
    condition: { maxAge: 604800, type: "Age" },
  },
};

test("Development lifecycle setup preserves unrelated rules and is idempotent", async () => {
  const existing = {
    id: "retain-legal-fixtures",
    conditions: { prefix: "legal/" },
    enabled: true,
  };
  let rules = [existing];
  const updates = [];
  const cf = {
    storyVideoLifecycle: async () => ({ rules }),
    updateStoryVideoLifecycle: async (next) => {
      updates.push(next);
      rules = next;
    },
  };

  await ensureDevelopmentStorageLifecycle(cf);
  await ensureDevelopmentStorageLifecycle(cf);

  assert.equal(updates.length, 1);
  assert.deepEqual(rules, [existing, MANAGED_RULE]);
});

const env = {GITHUB_RUN_ID:"123",GITHUB_SHA:"a".repeat(40),NATIVE_VERIFY_RELEASE:"native-100"};
const inventory = {schemaVersion:1,runId:"123",sourceCommit:env.GITHUB_SHA,releaseId:env.NATIVE_VERIFY_RELEASE,fixtures:[]};
function evidenceStore() {
  const objects = new Map(), saves=[];
  return {saves, save:async (name,bytes)=>{saves.push(name);objects.set(name,bytes);return {key:name};},
    read:async ref=>objects.get(ref.key)};
}
test("cleanup preserves the inventory before verifying lifecycle or mutating anything",async()=>{
 const store=evidenceStore();
 const cf={storyVideoLifecycle:async()=>{assert.deepEqual(store.saves,["qualification-cleanup-inventory.json"]);return {rules:[MANAGED_RULE]};}};
 const result=await cleanupDevelopmentQualification(env,cf,{store,inventory});
 assert.equal(result.cleanupComplete,true);
 assert.equal(result.originalRunId,"123");
 assert.deepEqual(store.saves,["qualification-cleanup-inventory.json","qualification-cleanup-complete.json"]);
});
test("failed durable inventory persistence cannot start cleanup",async()=>{
 let called=false;
 await assert.rejects(cleanupDevelopmentQualification(env,{storyVideoLifecycle:async()=>{called=true;}},
  {inventory,store:{save:async()=>{throw Error("store unavailable");}}}),/store unavailable/);
 assert.equal(called,false);
});
test("routine lifecycle verification never updates a missing policy or issues a completion receipt",async()=>{
 const store=evidenceStore();let writes=0;
 await assert.rejects(cleanupDevelopmentQualification(env,{storyVideoLifecycle:async()=>({rules:[]}),updateStoryVideoLifecycle:async()=>writes++},
  {inventory,store}),/lifecycle differs/);
 assert.equal(writes,0);assert.equal(store.saves.length,1);
});
