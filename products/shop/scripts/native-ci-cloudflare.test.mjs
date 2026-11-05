import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { developmentCloudflare, CLOUDFLARE_ACCOUNT, DEVELOPMENT_DATABASE } from "./native-ci-cloudflare.mjs";
const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "bentbrain/bent-mono", GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"), GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"),
    GITHUB_REF: "refs/heads/perf/story-video-family-experiments", GITHUB_SHA: "a".repeat(40), GITHUB_EVENT_NAME: "push", GITHUB_RUN_ID: "123",
    GITHUB_WORKFLOW_REF: "bentbrain/bent-mono/.github/workflows/native-development.yml@refs/heads/perf/story-video-family-experiments",
    CLOUDFLARE_ACCOUNT_ID: CLOUDFLARE_ACCOUNT, CLOUDFLARE_API_TOKEN: "fixture-secret", WORKER_URL: "https://forever-tee-api-development.socialqueue.workers.dev" };
test("Cloudflare CI requests stay in the exact personal Development account, Worker and D1 database", async () => {
    const calls = [];
    const cf = developmentCloudflare(env, async (url, options) => {
        calls.push({ url, options });
        assert.equal(options.headers.Authorization, "Bearer fixture-secret");
        assert.equal(options.redirect, "error");
        return Response.json({ success: true, result: options.method === "POST" ? [{ success: true, results: [] }] : {} });
    });
    await cf.settings();
    await cf.deployments();
    await cf.database();
    await cf.query("SELECT ?", [1]);
    assert.deepEqual(calls.map(call => call.url), [
        `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT}/workers/scripts/forever-tee-api-development/settings`,
        `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT}/workers/scripts/forever-tee-api-development/deployments`,
        `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT}/d1/database/${DEVELOPMENT_DATABASE}`,
        `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT}/d1/database/${DEVELOPMENT_DATABASE}/query`,
    ]);
    assert.equal(calls[3].options.body, JSON.stringify({ sql: "SELECT ?", params: [1] }));
    for (const delta of [{ GITHUB_ACTIONS: "false" }, { GITHUB_REPOSITORY_ID: "other" }, { CLOUDFLARE_ACCOUNT_ID: "work" },
        { WORKER_URL: "https://forever-tee-api.socialqueue.workers.dev" }, { CLOUDFLARE_API_TOKEN: "" }, { GITHUB_EVENT_NAME: "pull_request" }]) {
        assert.throws(() => developmentCloudflare({ ...env, ...delta }, () => assert.fail("No request permitted")));
    }
});
test("uncertain, denied and failed D1 responses are not retried or logged", async () => {
    for (const send of [async () => { throw new Error("fixture-secret"); }, async () => new Response("fixture-secret", { status: 403 }),
        async () => Response.json({ success: false, errors: ["fixture-secret"] }),
        async () => Response.json({ success: true, result: [{ success: false, error: "fixture-secret" }] })]) {
        let calls = 0;
        const cf = developmentCloudflare(env, (...args) => { calls++; return send(...args); });
        await assert.rejects(cf.query("SELECT 1"), error => !error.message.includes("fixture-secret"));
        assert.equal(calls, 1);
    }
});
test("Development release exposes no standalone Worker secret mutation", () => {
    assert.equal(developmentCloudflare(env).setSecret, undefined);
});
test("schedule repair sends one fixed Development registration only in its guarded operation", async () => {
    const repair = { ...env, GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ATTEMPT: "1",
        GITHUB_WORKFLOW_REF: "bentbrain/bent-mono/.github/workflows/native-development.yml@refs/heads/main",
        NATIVE_OPERATION: "repair-schedule", NATIVE_VERIFY_RELEASE: "native-100" };
    const calls = [];
    const cf = developmentCloudflare(repair, async (url, options) => {
        calls.push({ url, options });
        return Response.json({ success: true, result: { schedules: [{ cron: "* * * * *" }] } });
    });
    await cf.schedules();
    await cf.repairSchedule();
    assert.deepEqual(calls.map(call => call.options.method), ["GET", "PUT"]);
    assert.equal(calls[1].url, `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT}/workers/scripts/forever-tee-api-development/schedules`);
    assert.equal(calls[1].options.body, JSON.stringify([{ cron: "* * * * *" }]));
    for (const delta of [{ NATIVE_OPERATION: "release", NATIVE_VERIFY_RELEASE: "" }, { GITHUB_RUN_ATTEMPT: "2" },
        { GITHUB_EVENT_NAME: "push" }, { NATIVE_VERIFY_RELEASE: "" }]) {
        assert.throws(() => developmentCloudflare({ ...repair, ...delta }, () => assert.fail("No request permitted")).repairSchedule());
    }
    let attempts = 0;
    await assert.rejects(developmentCloudflare(repair, async () => { attempts++; throw Error("fixture-secret"); }).repairSchedule(), error => !error.message.includes("fixture-secret"));
    assert.equal(attempts, 1);
});
test("qualification can read canonical saved artwork but writes only fresh fixture keys", async () => {
    const calls = [];
    const cf = developmentCloudflare(env, async (url, options) => { calls.push({ url, options }); return new Response("artwork"); });
    const design = "2fc159fa-8592-4599-9478-9aaf6697537f";
    const source = `designs/${design}/artwork/${"a".repeat(64)}`;
    const fixtureBytes = Buffer.from("fixture");
    const fixture = `designs/${design}/artwork/${createHash("sha256").update(fixtureBytes).digest("hex")}`;
    await cf.readArtwork(source);
    await cf.createQualificationArtwork(fixture, fixtureBytes);
    await cf.readArtwork(fixture);
    assert.equal(calls[0].options.method, "GET");
    assert.equal(calls[1].options.headers["If-None-Match"], "*");
    assert.equal(calls[1].options.method, "PUT");
    for (const key of [source, `designs/${design}/other.png`])
        await assert.rejects(cf.createQualificationArtwork(key, Buffer.from("overwrite")));
    for (const key of ["../production", `${fixture}?override=true`, `designs/${design}/artwork/unknown`])
        await assert.rejects(cf.readArtwork(key));
    assert.equal(calls.length, 3);
});
test("qualification cleanup deletes only bounded Development object keys", async () => {
    const calls = [];
    const cf = developmentCloudflare(env, async (url, options) => {
        calls.push({ url, options });
        return new Response(null, { status: 204 });
    });
    const design = "2fc159fa-8592-4599-9478-9aaf6697537f";
    const product = "97b629d7-1d3b-4d2a-a586-537168141e97";
    const digest = "a".repeat(64);
    await cf.deleteQualificationArtwork(`designs/${design}/artwork/${digest}`);
    await cf.deleteQualificationArtwork(`print-assets/blobs/${digest}.png`);
    await cf.deleteQualificationVideo(`story-videos/v7/${design}/${product}/black.mp4`);
    assert.deepEqual(calls.map(call => call.options.method), ["GET", "DELETE", "GET", "DELETE", "GET", "DELETE"]);
    assert.match(calls[0].url, /design-artwork-development/u);
    assert.match(calls[4].url, /story-videos-development/u);
    for (const key of ["../production", `source/releases/${digest}`, `benchmarks/${digest}.mp4`]) {
        await assert.rejects(cf.deleteQualificationArtwork(key));
        await assert.rejects(cf.deleteQualificationVideo(key));
    }
    assert.equal(calls.length, 6);
});
test('an uncertain object deletion is inspected on recovery and is not repeated if absent', async () => {
    const methods = [];
    let exists = true;
    const cf = developmentCloudflare(env, async (_url, options) => {
        methods.push(options.method);
        if (options.method === 'DELETE') {
            exists = false;
            throw Error('lost acknowledgement');
        }
        return new Response(null, { status: exists ? 200 : 404 });
    });
    const key = `designs/11111111-1111-4111-8111-111111111111/artwork/${'a'.repeat(64)}`;
    await assert.rejects(cf.deleteQualificationArtwork(key));
    await cf.deleteQualificationArtwork(key);
    assert.deepEqual(methods, ['GET', 'DELETE', 'GET']);
});
test('D1 batching uses the exact Development database and requires every statement result', async () => {
    const statements = [{ sql: 'SELECT 1', params: [] }, { sql: 'SELECT 2', params: [] }];
    const cf = developmentCloudflare(env, async (url, options) => {
        assert.ok(url.endsWith(`/d1/database/${DEVELOPMENT_DATABASE}/query`));
        assert.deepEqual(JSON.parse(options.body), { batch: statements });
        return Response.json({ success: true, result: [{ success: true }, { success: true }] });
    });
    assert.equal((await cf.batch(statements)).length, 2);
    const short = developmentCloudflare(env, async () => Response.json({ success: true, result: [{ success: true }] }));
    await assert.rejects(short.batch(statements), /transaction/);
});
