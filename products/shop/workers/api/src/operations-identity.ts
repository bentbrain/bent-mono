import { protectedConfig } from "./protected-config";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
const REPOSITORY_ID = protectedConfig("githubRepositoryId");
const OWNER_ID = protectedConfig("githubOwnerId");
const issuer = "https://token.actions.githubusercontent.com";
const githubKeys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`));
export interface OperationsIdentityEnv {
    readonly OPERATIONS_ENVIRONMENT?: string;
}
export interface OperationsIdentity {
    readonly actor: string;
    readonly actorId: string;
    readonly owner: boolean;
    readonly runId: string;
}
export async function operationsAudience(request: Request, environment: string, body: string) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    return `bent-shirt:operations:${environment}:${request.method}:${new URL(request.url).pathname}:${hash}`;
}
// Verify the workflow actor rather than trusting a caller-supplied actor/owner
// field. Bind the signed audience to this exact operation and request body.
export async function verifyOperationsIdentity(request: Request, env: OperationsIdentityEnv, body: string, keys: JWTVerifyGetKey = githubKeys): Promise<OperationsIdentity | undefined> {
    const environment = env.OPERATIONS_ENVIRONMENT;
    if (environment !== "production" && environment !== "development")
        return undefined;
    const path = new URL(request.url).pathname;
    const workflow = path === "/v2/internal/operations/product-lifecycle" ? "product-lifecycle.yml"
        : path === "/v2/internal/operations/featured-products" ? "featured-products.yml"
            : path === "/v2/internal/operations/paid-order-product-recovery" ? "paid-order-product-recovery.yml"
                : path === "/v2/internal/operations/paid-order-provider-recovery" ? "paid-order-provider-recovery.yml"
                    : path === "/v2/internal/operations/paid-order-validation-recovery" ? "paid-order-validation-recovery.yml" : undefined;
    if (!workflow)
        return undefined;
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ") || authorization.length > 20000)
        return undefined;
    try {
        const { payload } = await jwtVerify(authorization.slice(7), keys, {
            algorithms: ["RS256"], issuer,
            audience: await operationsAudience(request, environment, body),
            maxTokenAge: "10m", clockTolerance: 5,
            requiredClaims: ["exp", "iat", "nbf", "jti"],
        });
        if (payload["repository_id"] !== REPOSITORY_ID ||
            payload["repository_owner_id"] !== OWNER_ID ||
            payload["ref"] !== "refs/heads/main" ||
            payload["workflow_ref"] !== `bentbrain/bent-mono/.github/workflows/${workflow}@refs/heads/main` ||
            payload["event_name"] !== "workflow_dispatch" ||
            payload["runner_environment"] !== "github-hosted" ||
            payload["environment"] !== (environment === "production" ? "Production" : "Preview"))
            return undefined;
        if ((workflow === "paid-order-validation-recovery.yml" || workflow === "paid-order-product-recovery.yml" || workflow === "paid-order-provider-recovery.yml") && payload["run_attempt"] !== "1")
            return undefined;
        const actor = payload["actor"];
        const actorId = payload["actor_id"];
        const runId = payload["run_id"];
        if (typeof actor !== "string" || !/^[a-zA-Z0-9-]{1,39}$/.test(actor) ||
            typeof actorId !== "string" || !/^\d{1,20}$/.test(actorId) ||
            typeof runId !== "string" || !/^\d{1,20}$/.test(runId))
            return undefined;
        return { actor, actorId, runId, owner: actorId === OWNER_ID };
    }
    catch {
        return undefined;
    }
}
