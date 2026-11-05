import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { inspectProductionIdentity, verifyProductionToken, PRODUCTION_SUBJECT } from "./native-production-identity.mjs";
const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "bentbrain/bent-mono", GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"),
    GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"), GITHUB_REF: "refs/heads/main", GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "123",
    GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ATTEMPT: "1", GITHUB_WORKFLOW_REF: "bentbrain/bent-mono/.github/workflows/native-production-identity.yml@refs/heads/main" };
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keys = [{ ...pair.publicKey.export({ format: "jwk" }), kid: "fixture", use: "sig" }];
const claims = { iss: "https://token.actions.githubusercontent.com", aud: "sts.amazonaws.com", sub: PRODUCTION_SUBJECT,
    repository: env.GITHUB_REPOSITORY, repository_id: env.GITHUB_REPOSITORY_ID, repository_owner: "bentbrain", repository_owner_id: env.GITHUB_REPOSITORY_OWNER_ID,
    environment: "Production", ref: env.GITHUB_REF, sha: env.GITHUB_SHA, run_id: env.GITHUB_RUN_ID, run_attempt: "1", event_name: env.GITHUB_EVENT_NAME,
    workflow_ref: env.GITHUB_WORKFLOW_REF, iat: 1000, nbf: 1000, exp: 1300 };
function token(value = claims) {
    const body = [JSON.stringify({ alg: "RS256", kid: "fixture" }), JSON.stringify(value)].map(value => Buffer.from(value).toString("base64url")).join(".");
    return `${body}.${sign("RSA-SHA256", Buffer.from(body), pair.privateKey).toString("base64url")}`;
}
test("Production identity is main-only, exact-subject and first manual attempt", () => {
    const jwt = token({ ...claims, ignoredSecret: "never-log-this" }), result = verifyProductionToken(jwt, keys, env, 1100);
    assert.equal(result.subject, PRODUCTION_SUBJECT);
    assert.equal(result.deploymentAttempted, false);
    assert.equal(JSON.stringify(result).includes("never-log-this"), false);
    assert.equal(JSON.stringify(result).includes(jwt), false);
    for (const delta of [{ ref: "refs/heads/perf/story-video-family-experiments" }, { environment: "Preview" }, { sub: PRODUCTION_SUBJECT.replace("Production", "Preview") },
        { repository_id: "work" }, { repository_owner_id: "work" }, { run_attempt: "2" }, { event_name: "push" }, { exp: 1001 }, { sha: "b".repeat(40) },
        { workflow_ref: "foreign" }, { aud: "foreign" }])
        assert.throws(() => verifyProductionToken(token({ ...claims, ...delta }), keys, env, 1100));
    for (const delta of [{ GITHUB_REF: "refs/heads/perf/story-video-family-experiments" }, { GITHUB_RUN_ATTEMPT: "2" }, { GITHUB_EVENT_NAME: "push" },
        { GITHUB_WORKFLOW_REF: "foreign" }])
        assert.throws(() => verifyProductionToken(token(), keys, { ...env, ...delta }, 1100));
});
test("Production identity rejects invalid signatures and local or foreign endpoint requests", async () => {
    assert.throws(() => verifyProductionToken(token().slice(0, -20) + "bad", keys, env, 1100));
    const noNetwork = () => assert.fail("No request permitted");
    await assert.rejects(inspectProductionIdentity({}, noNetwork));
    await assert.rejects(inspectProductionIdentity({ ...env, ACTIONS_ID_TOKEN_REQUEST_URL: "https://evil.test", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "secret" }, noNetwork));
});
