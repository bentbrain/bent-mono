import { resolveProtectedTemplate } from "./protected-config.mjs";
import { developmentCloudflare } from "./native-ci-cloudflare.mjs";
import { createDevelopmentReleaseStore } from "./native-ci-release-store.mjs";
import { captureQualificationInventory, deleteQualificationInventory, validateQualificationInventory } from "./native-qualification-inventory.mjs";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
const check = (value, reason) => {
    if (!value)
        throw new Error(`Native qualification cleanup failed: ${reason}`);
};
export async function cleanupDevelopmentQualification(env = process.env, cf = developmentCloudflare(env), options = {}) {
    check(!options.inventory || options.inventoryReference || !options.requireSavedInventory, "saved inventory reference missing; inspect the uncertain create-only save.");
    const store = options.store ?? await createDevelopmentReleaseStore(env);
    const inventory = options.inventory ?? await captureQualificationInventory(cf, env);
    const originalEnv = options.originalEnv ?? env;
    validateQualificationInventory(inventory, originalEnv);
    // This reference is saved and read back before the first database deletion.
    const inventoryReference = options.inventoryReference ?? await store.save("qualification-cleanup-inventory.json", Buffer.from(JSON.stringify(inventory)));
    check(isDeepStrictEqual(JSON.parse(await store.read(inventoryReference)), inventory), "durable inventory readback.");
    let lifecycleFailure;
    try {
        await verifyDevelopmentStorageLifecycle(cf);
    }
    catch (error) {
        lifecycleFailure = error;
    }
    let result;
    try {
        result = await deleteQualificationInventory(cf, inventory, originalEnv);
    }
    catch (error) {
        if (lifecycleFailure) throw new AggregateError([lifecycleFailure, error], "Qualification lifecycle verification and inventory deletion failed.", { cause: lifecycleFailure });
        throw error;
    }
    if (lifecycleFailure)
        throw lifecycleFailure;
    const receipt = { schemaVersion: 1, cleanupComplete: true, runId: env.GITHUB_RUN_ID,
        originalRunId: inventory.runId, releaseId: inventory.releaseId, qualificationSourceCommit: inventory.sourceCommit,
        inventoryReference, ...result };
    const evidence = await store.save("qualification-cleanup-complete.json", Buffer.from(JSON.stringify(receipt)));
    return { ...receipt, evidence };
}
async function verifyDevelopmentStorageLifecycle(cf) {
    const configured = JSON.parse(resolveProtectedTemplate(await readFile(new URL("../infra/cloudflare/r2-story-video-development-lifecycle.json", import.meta.url), "utf8")));
    const rules = (await cf.storyVideoLifecycle())?.rules;
    check(configured.rules?.length === 1 && Array.isArray(rules) && rules.some(rule => isDeepStrictEqual(rule, configured.rules[0])), "Development benchmark lifecycle differs; repair it through infrastructure provisioning.");
    return configured.rules[0];
}
export async function ensureDevelopmentStorageLifecycle(cf) {
    const source = await readFile(new URL("../infra/cloudflare/r2-story-video-development-lifecycle.json", import.meta.url), "utf8");
    const configured = JSON.parse(source);
    const managed = configured?.rules?.[0];
    check(configured?.rules?.length === 1 &&
        managed?.id === "expire-development-benchmarks-after-seven-days" &&
        managed.enabled === true && managed.conditions?.prefix === "benchmarks/" &&
        managed.deleteObjectsTransition?.condition?.type === "Age" &&
        managed.deleteObjectsTransition.condition.maxAge === 604800, "reviewed benchmark lifecycle policy.");
    const current = await cf.storyVideoLifecycle();
    check(Array.isArray(current?.rules), "existing Development lifecycle rules.");
    const rules = [
        ...current.rules.filter(rule => rule.id !== managed.id),
        managed,
    ];
    if (!isDeepStrictEqual(current.rules, rules)) {
        await cf.updateStoryVideoLifecycle(rules);
    }
    const verified = await cf.storyVideoLifecycle();
    check(Array.isArray(verified?.rules) &&
        verified.rules.some(rule => isDeepStrictEqual(rule, managed)), "Development benchmark lifecycle readback.");
    return managed;
}
