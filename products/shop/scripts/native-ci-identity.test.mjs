import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { inspectActionsIdentity, verifyActionsToken } from "./native-ci-identity.mjs";
const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "bentbrain/bent-mono", GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"),
    GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"), GITHUB_REF: "refs/heads/main", GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "123", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ATTEMPT: "1", GITHUB_WORKFLOW_REF: "bentbrain/bent-mono/.github/workflows/native-ci-identity.yml@refs/heads/main" };
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keys = [{ ...pair.publicKey.export({ format: "jwk" }), kid: "fixture", use: "sig" }];
const claims = { iss: "https://token.actions.githubusercontent.com", aud: "sts.amazonaws.com", repository: env.GITHUB_REPOSITORY,
    repository_id: env.GITHUB_REPOSITORY_ID, repository_owner: "bentbrain", repository_owner_id: env.GITHUB_REPOSITORY_OWNER_ID, environment: "Preview",
    ref: env.GITHUB_REF, sha: env.GITHUB_SHA, run_id: env.GITHUB_RUN_ID, run_attempt: "1", event_name: env.GITHUB_EVENT_NAME,
    workflow_ref: `bentbrain/bent-mono/.github/workflows/native-ci-identity.yml@${env.GITHUB_REF}`,
    iat: 1000, nbf: 1000, exp: 1300, sub: "repo:bentbrain@" + protectedConfig("githubOwnerId") + "/bent-mono@" + protectedConfig("githubRepositoryId") + ":environment:Preview" };
function token(value = claims, alg = "RS256") {
    const payload = [JSON.stringify({ alg, kid: "fixture" }), JSON.stringify(value)].map(value => Buffer.from(value).toString("base64url")).join(".");
    return `${payload}.${sign("RSA-SHA256", Buffer.from(payload), pair.privateKey).toString("base64url")}`;
}
test("identity diagnostic verifies the signature and returns only bounded non-secret claims", () => {
    const jwt = token({ ...claims, unrelatedSecret: "not-for-logs" });
    const result = verifyActionsToken(jwt, keys, env, 1100);
    assert.equal(result.signatureVerified, true);
    assert.equal(result.subject, claims.sub);
    assert.equal(result.awsAccessAttempted, false);
    assert.equal(JSON.stringify(result).includes("not-for-logs"), false);
    assert.equal(JSON.stringify(result).includes(jwt), false);
});
test("wrong repository, environment, issuer, audience, commit, workflow and expired tokens fail closed", () => {
    for (const changed of [{ repository_id: "1" }, { run_attempt: "2" }, { sub: "repo:other:environment:Preview" }, { environment: "Production" }, { iss: "https://evil.test" }, { aud: "other" },
        { sha: "b".repeat(40) }, { workflow_ref: "other" }, { exp: 1001 }, { nbf: 2000 }, { event_name: "pull_request" }]) {
        assert.throws(() => verifyActionsToken(token({ ...claims, ...changed }), keys, env, 1100));
    }
    for (const delta of [{ GITHUB_REF: "refs/heads/perf/story-video-family-experiments" }, { GITHUB_RUN_ATTEMPT: "2" }, { GITHUB_EVENT_NAME: "push" }, { GITHUB_WORKFLOW_REF: "foreign" }])
        assert.throws(() => verifyActionsToken(token(), keys, { ...env, ...delta }, 1100));
    assert.throws(() => verifyActionsToken(token(claims, "none"), keys, env, 1100));
    assert.throws(() => verifyActionsToken(token().slice(0, -20) + "bad", keys, env, 1100));
});
test("local execution cannot request a token or use a caller-supplied endpoint", async () => {
    let requests = 0;
    const request = async () => { requests++; throw new Error("secret"); };
    await assert.rejects(inspectActionsIdentity({}, request));
    await assert.rejects(inspectActionsIdentity({ ...env, ACTIONS_ID_TOKEN_REQUEST_URL: "https://evil.test", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "secret" }, request));
    assert.equal(requests, 0);
});

test("forward recovery verifies a fresh canonical Development workflow signature while historical repository tokens remain rejected", () => {
    const context = { ...env, GITHUB_WORKFLOW_REF: "bentbrain/bent-mono/.github/workflows/native-development.yml@refs/heads/main",
        NATIVE_OPERATION: "recover-forward-release", NATIVE_RELEASE_MODE: "full" };
    const current = { ...claims, workflow_ref: context.GITHUB_WORKFLOW_REF };
    for (const operation of ["stage-forward-recovery-authority", "plan-forward-recovery", "recover-forward-release"])
        assert.equal(verifyActionsToken(token(current), keys, { ...context, NATIVE_OPERATION: operation }, 1100, { nativeDevelopment: true }).signatureVerified, true);
    for (const delta of [{ repository: "fixtures/retired-release" }, { repository_id: "70001" }, { run_attempt: "2" }, { environment: "Production" },
        { workflow_ref: claims.workflow_ref }, { run_id: "999" }, { sha: "b".repeat(40) }])
        assert.throws(() => verifyActionsToken(token({ ...current, ...delta }), keys, context, 1100, { nativeDevelopment: true }));
    assert.throws(() => verifyActionsToken(token(current), keys, { ...context, NATIVE_OPERATION: "release" }, 1100, { nativeDevelopment: true }));
});
