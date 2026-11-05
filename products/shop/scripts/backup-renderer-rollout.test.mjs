import { protectedConfig } from "./protected-config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readBackupContainer, waitForBackupPair } from "./backup-renderer-rollout.mjs";
const before = { workerVersion: "old-worker", container: { id: "container", image: "old-image", version: 23, state: "ready" } };
const pending = { ...before, workerVersion: "new-worker" };
const ready = { workerVersion: "new-worker", container: { ...before.container, image: "new-image", version: 24 } };
const accountId = protectedConfig("cloudflareAccountId");
const image = `registry.cloudflare.com/${accountId}/featured-backup@sha256:${"b".repeat(64)}`;
function application() {
    return { id: "container", account_id: accountId, name: "backup", version: 24,
        configuration: { image }, health: { errors: [], instances: { failed: 0, starting: 0, scheduling: 0, active: 0 } } };
}
test("a stale dashboard list cannot hide the completed exact application rollout", async () => {
    const calls = [];
    const wrangler = async (args) => {
        calls.push(args);
        return JSON.stringify(args[1] === "info" ? application() : [before.container]);
    };
    const actual = await waitForBackupPair(async () => ({ workerVersion: "new-worker",
        container: await readBackupContainer(wrangler, "container", accountId) }), before, image, { attempts: 1, pause: async () => { throw Error("A completed rollout needs no extra wait"); } });
    assert.equal(actual.container.version, 24);
    assert.equal(actual.container.image, image);
    assert.deepEqual(calls, [["containers", "info", "container", "--json"]]);
});
test("application detail health cannot qualify provisioning or failed containers", async () => {
    for (const [field, state] of [["starting", "provisioning"], ["scheduling", "provisioning"], ["failed", "degraded"], ["active", "active"]]) {
        const detail = application();
        detail.health.instances[field] = 1;
        const container = await readBackupContainer(async () => JSON.stringify(detail), "container", accountId);
        assert.equal(container.state, state);
        await assert.rejects(waitForBackupPair(async () => ({ workerVersion: "new-worker", container }), before, image, { attempts: 1 }), /not confirmed/);
    }
    const detail = application();
    detail.health.errors.push({ message: "image unavailable" });
    assert.equal((await readBackupContainer(async () => JSON.stringify(detail), "container", accountId)).state, "degraded");
});
test("missing health, foreign identity and malformed application details fail closed", async () => {
    const valid = application();
    for (const detail of [null, { ...valid, id: "foreign" }, { ...valid, account_id: "foreign" },
        { ...valid, version: 0 }, { ...valid, configuration: {} }, { ...valid, health: undefined },
        { ...valid, health: { errors: [], instances: { failed: 0 } } }]) {
        await assert.rejects(readBackupContainer(async () => JSON.stringify(detail), "container", accountId), /configuration and health/);
    }
});
test("a Worker update waits for the asynchronous container rollout without redeploying", async () => {
    const states = [before, pending, pending, ready];
    let reads = 0, waits = 0;
    const result = await waitForBackupPair(async () => states[reads++], before, "new-image", {
        attempts: 4, pause: async () => { waits++; }
    });
    assert.deepEqual(result, ready);
    assert.equal(reads, 4);
    assert.equal(waits, 3);
});
test("a rollout that never completes remains unqualified", async () => {
    let reads = 0;
    await assert.rejects(waitForBackupPair(async () => { reads++; return pending; }, before, "new-image", {
        attempts: 3, pause: async () => { }
    }), /not confirmed/);
    assert.equal(reads, 3);
});
test("an unexpected container change stops immediately", async () => {
    let reads = 0;
    await assert.rejects(waitForBackupPair(async () => {
        reads++;
        return { ...ready, container: { ...ready.container, image: "foreign-image" } };
    }, before, "new-image", { attempts: 3, pause: async () => { } }), /unexpected/);
    assert.equal(reads, 1);
});
test("the intended image and Worker cannot pass while the container is still preparing", async () => {
    let reads = 0, waits = 0;
    const states = [{ ...pending, container: { ...before.container, state: "provisioning" } },
        { ...ready, container: { ...ready.container, state: "provisioning" } }, ready];
    assert.deepEqual(await waitForBackupPair(async () => states[reads++], before, "new-image", {
        attempts: 3, pause: async () => { waits++; }
    }), ready);
    assert.equal(reads, 3);
    assert.equal(waits, 2);
});
test("an unready container or unexpected rollout version never qualifies", async () => {
    for (const container of [{ ...ready.container, state: "pending" }, { ...ready.container, state: undefined },
        { ...ready.container, version: before.container.version }, { ...ready.container, version: before.container.version + 2 }]) {
        await assert.rejects(waitForBackupPair(async () => ({ ...ready, container }), before, "new-image", {
            attempts: 2, pause: async () => { }
        }), /not confirmed/);
    }
});
