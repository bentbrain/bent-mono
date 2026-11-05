import { protectedConfig } from "./protected-config.mjs";
import { createPublicKey, verify } from "node:crypto";
import { pathToFileURL } from "node:url";
const ISSUER = "https://token.actions.githubusercontent.com";
const WORKFLOW = "bentbrain/bent-mono/.github/workflows/native-production-identity.yml@refs/heads/main";
export const PRODUCTION_SUBJECT = "repo:bentbrain@" + protectedConfig("githubOwnerId") + "/bent-mono@" + protectedConfig("githubRepositoryId") + ":environment:Production";
const fail = () => { throw new Error("Production identity verification failed; no AWS access or deployment attempted."); };
export function assertProductionIdentityContext(env) {
    if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_REPOSITORY !== "bentbrain/bent-mono" ||
        env.GITHUB_REPOSITORY_ID !== protectedConfig("githubRepositoryId") || env.GITHUB_REPOSITORY_OWNER_ID !== protectedConfig("githubOwnerId") ||
        env.GITHUB_REF !== "refs/heads/main" || env.GITHUB_EVENT_NAME !== "workflow_dispatch" || env.GITHUB_RUN_ATTEMPT !== "1" ||
        env.GITHUB_WORKFLOW_REF !== WORKFLOW || !/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? "") || !/^\d+$/.test(env.GITHUB_RUN_ID ?? ""))
        fail();
}
export function verifyProductionToken(token, keys, env, now = Math.floor(Date.now() / 1000)) {
    assertProductionIdentityContext(env);
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
    for (const [key, expected] of Object.entries({ iss: ISSUER, aud: "sts.amazonaws.com", sub: PRODUCTION_SUBJECT,
        repository: "bentbrain/bent-mono", repository_id: protectedConfig("githubRepositoryId"), repository_owner: "bentbrain", repository_owner_id: protectedConfig("githubOwnerId"),
        environment: "Production", ref: "refs/heads/main", sha: env.GITHUB_SHA, run_id: env.GITHUB_RUN_ID,
        run_attempt: "1", event_name: "workflow_dispatch", workflow_ref: WORKFLOW }))
        if (claims[key] !== expected)
            fail();
    if (![claims.iat, claims.nbf, claims.exp].every(Number.isSafeInteger) || claims.exp <= now || claims.nbf > now + 60 ||
        claims.iat > now + 60 || now - claims.iat > 600 || claims.exp - claims.iat > 600)
        fail();
    return { signatureVerified: true, issuer: claims.iss, audience: claims.aud, subject: claims.sub, repositoryId: claims.repository_id, ownerId: claims.repository_owner_id, runAttempt: claims.run_attempt,
        environment: claims.environment, ref: claims.ref, sourceCommit: claims.sha, runId: claims.run_id, workflowRef: claims.workflow_ref,
        awsAccessAttempted: false, deploymentAttempted: false };
}
export async function inspectProductionIdentity(env = process.env, request = fetch) {
    assertProductionIdentityContext(env);
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
        const response = await request(url, { headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }, redirect: "error", signal: AbortSignal.timeout(20000) });
        if (!response.ok)
            fail();
        const token = await response.json();
        const responseKeys = await request(`${ISSUER}/.well-known/jwks`, { redirect: "error", signal: AbortSignal.timeout(20000) });
        if (!responseKeys.ok)
            fail();
        const keys = await responseKeys.json();
        return verifyProductionToken(token.value, keys.keys, env);
    }
    catch {
        fail();
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        console.info(JSON.stringify(await inspectProductionIdentity()));
    }
    catch {
        console.error("Production identity verification failed; no token logged, AWS access or deployment attempted.");
        process.exitCode = 1;
    }
}
