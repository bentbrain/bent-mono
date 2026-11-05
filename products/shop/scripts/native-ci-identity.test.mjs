import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { inspectActionsIdentity, verifyActionsToken } from "./native-ci-identity.mjs";
const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "bentbrain/bent-mono", GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"),
    GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"), GITHUB_REF: "refs/heads/perf/story-video-family-experiments", GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "123", GITHUB_EVENT_NAME: "push" };
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keys = [{ ...pair.publicKey.export({ format: "jwk" }), kid: "fixture", use: "sig" }];
const claims = { iss: "https://token.actions.githubusercontent.com", aud: "sts.amazonaws.com", repository: env.GITHUB_REPOSITORY,
    repository_id: env.GITHUB_REPOSITORY_ID, repository_owner: "bentbrain", repository_owner_id: env.GITHUB_REPOSITORY_OWNER_ID, environment: "Preview",
    ref: env.GITHUB_REF, sha: env.GITHUB_SHA, run_id: env.GITHUB_RUN_ID, event_name: env.GITHUB_EVENT_NAME,
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
    for (const changed of [{ repository_id: "1" }, { environment: "Production" }, { iss: "https://evil.test" }, { aud: "other" },
        { sha: "b".repeat(40) }, { workflow_ref: "other" }, { exp: 1001 }, { nbf: 2000 }, { event_name: "pull_request" }]) {
        assert.throws(() => verifyActionsToken(token({ ...claims, ...changed }), keys, env, 1100));
    }
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
