import { protectedConfig } from "./protected-config.mjs";
import { createPublicKey, verify } from "node:crypto";
import { pathToFileURL } from "node:url";
const ISSUER = "https://token.actions.githubusercontent.com";
const WORKFLOW = "bentbrain/bent-mono/.github/workflows/native-ci-identity.yml";
const REFS = ["refs/heads/main", "refs/heads/perf/story-video-family-experiments"];
const WORKFLOW_REF = `${WORKFLOW}@refs/heads/main`;
const SUBJECT = "repo:bentbrain@" + protectedConfig("githubOwnerId") + "/bent-mono@" + protectedConfig("githubRepositoryId") + ":environment:Preview";
const fail = () => { throw new Error("Native CI identity verification failed; no AWS access attempted."); };
export function assertActionsIdentityContext(env) {
    if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_REPOSITORY !== "bentbrain/bent-mono" ||
        env.GITHUB_REPOSITORY_ID !== protectedConfig("githubRepositoryId") || env.GITHUB_REPOSITORY_OWNER_ID !== protectedConfig("githubOwnerId") ||
        !REFS.includes(env.GITHUB_REF) || !["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME) ||
        !/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? "") || !/^\d+$/.test(env.GITHUB_RUN_ID ?? ""))
        fail();
}
export function assertPreviewProofContext(env) {
    assertActionsIdentityContext(env);
    if (env.GITHUB_REF !== "refs/heads/main" || env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
        env.GITHUB_RUN_ATTEMPT !== "1" || env.GITHUB_WORKFLOW_REF !== WORKFLOW_REF) fail();
}
function assertNativeDevelopmentProofContext(env) {
    assertActionsIdentityContext(env);
    if (env.GITHUB_REF !== "refs/heads/main" || env.GITHUB_EVENT_NAME !== "workflow_dispatch" || env.GITHUB_RUN_ATTEMPT !== "1" ||
        env.GITHUB_WORKFLOW_REF !== "bentbrain/bent-mono/.github/workflows/native-development.yml@refs/heads/main" ||
        !["stage-forward-recovery-authority", "plan-forward-recovery", "recover-forward-release"].includes(env.NATIVE_OPERATION) || (env.NATIVE_RELEASE_MODE ?? "full") !== "full") fail();
}
const proofContext = (env, options) => options.nativeDevelopment ? assertNativeDevelopmentProofContext(env) : assertPreviewProofContext(env);
const proofWorkflow = options => options.nativeDevelopment ? "bentbrain/bent-mono/.github/workflows/native-development.yml" : WORKFLOW;
export function verifyActionsToken(token, keys, env, now = Math.floor(Date.now() / 1000), options = {}) {
    proofContext(env, options);
    if (typeof token !== "string" || token.length > 20000 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token))
        fail();
    const parts = token.split(".");
    let header, claims;
    try {
        header = JSON.parse(Buffer.from(parts[0], "base64url"));
        claims = JSON.parse(Buffer.from(parts[1], "base64url"));
    }
    catch {
        fail();
    }
    if (header.alg !== "RS256" || typeof header.kid !== "string" || !Array.isArray(keys))
        fail();
    const matches = keys.filter(key => key.kid === header.kid && key.kty === "RSA" && key.use === "sig");
    if (matches.length !== 1)
        fail();
    try {
        if (!verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: matches[0], format: "jwk" }), Buffer.from(parts[2], "base64url")))
            fail();
    }
    catch {
        fail();
    }
    for (const [key, expected] of Object.entries({ iss: ISSUER, aud: "sts.amazonaws.com", sub: SUBJECT, run_attempt: "1", repository: "bentbrain/bent-mono",
        repository_id: protectedConfig("githubRepositoryId"), repository_owner: "bentbrain", repository_owner_id: protectedConfig("githubOwnerId"), environment: "Preview",
        ref: env.GITHUB_REF, sha: env.GITHUB_SHA, run_id: env.GITHUB_RUN_ID, event_name: env.GITHUB_EVENT_NAME,
        workflow_ref: `${proofWorkflow(options)}@${env.GITHUB_REF}` }))
        if (claims[key] !== expected)
            fail();
    if (![claims.iat, claims.nbf, claims.exp].every(Number.isSafeInteger) || claims.exp <= now || claims.nbf > now + 60 ||
        claims.iat > now + 60 || now - claims.iat > 600 || claims.exp - claims.iat > 600 ||
        claims.sub !== SUBJECT)
        fail();
    // Record only verified non-secret claims. Never log/store the JWT, request
    // bearer token, response body, arbitrary claims or authentication headers.
    return { signatureVerified: true, issuer: claims.iss, audience: claims.aud, subject: claims.sub,
        repositoryId: claims.repository_id, ownerId: claims.repository_owner_id, runAttempt: claims.run_attempt, environment: claims.environment, ref: claims.ref,
        sourceCommit: claims.sha, runId: claims.run_id, workflowRef: claims.workflow_ref, awsAccessAttempted: false };
}
export async function inspectActionsIdentity(env = process.env, request = fetch, options = {}) {
    proofContext(env, options);
    let url;
    try {
        url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
    }
    catch {
        fail();
    }
    if (url.protocol !== "https:" || !/^[a-z0-9.-]+\.actions\.githubusercontent\.com$/.test(url.hostname) ||
        url.username || url.password || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
        fail();
    url.searchParams.set("audience", "sts.amazonaws.com");
    try {
        const tokenResponse = await request(url, { headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }, redirect: "error", signal: AbortSignal.timeout(20000) });
        if (!tokenResponse.ok)
            fail();
        const result = await tokenResponse.json();
        const keysResponse = await request(`${ISSUER}/.well-known/jwks`, { redirect: "error", signal: AbortSignal.timeout(20000) });
        if (!keysResponse.ok)
            fail();
        const keys = await keysResponse.json();
        return verifyActionsToken(result.value, keys.keys, env, Math.floor(Date.now() / 1000), options);
    }
    catch {
        fail();
    }
}
export const inspectNativeDevelopmentIdentity = env => inspectActionsIdentity(env, fetch, { nativeDevelopment: true });
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        console.info(JSON.stringify(await inspectActionsIdentity()));
    }
    catch {
        console.error("Native CI identity verification failed; no token logged and no AWS access attempted.");
        process.exitCode = 1;
    }
}
