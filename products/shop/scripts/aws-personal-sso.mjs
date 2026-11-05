import { protectedConfig } from "./protected-config.mjs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PERSONAL_ACCOUNT, PERSONAL_PROFILE, PERSONAL_REGION } from "./aws-personal-guard.mjs";
// Account-scoped permission discovery before role credentials exist. Read only
// the approved session's exact cache file, never enumerate or try other caches.
export async function personalSsoRoles(env, { read = readFile, request = fetch, now = Date.now() } = {}) {
    if (!env.HOME)
        throw new Error("Personal SSO cache location is unavailable.");
    const cacheName = createHash("sha1").update(PERSONAL_PROFILE).digest("hex");
    const session = JSON.parse(await read(join(env.HOME, ".aws/sso/cache", `${cacheName}.json`), "utf8"));
    if (session.startUrl !== protectedConfig("ssoStartUrl") || session.region !== PERSONAL_REGION ||
        typeof session.accessToken !== "string" || !session.accessToken ||
        !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= now) {
        throw new Error("The approved personal SSO session is unavailable or expired. No other session was tried.");
    }
    const url = new URL(`https://portal.sso.${PERSONAL_REGION}.amazonaws.com/assignment/roles`);
    url.search = new URLSearchParams({ account_id: PERSONAL_ACCOUNT, max_result: "100" });
    const response = await request(url, {
        method: "GET", headers: { "x-amz-sso_bearer_token": session.accessToken },
        redirect: "error", signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
        throw new Error(`Personal-account role lookup failed with HTTP ${response.status}. No other account was tried.`);
    const data = await response.json();
    if (!Array.isArray(data.roleList) || data.roleList.some((role) => role.accountId !== PERSONAL_ACCOUNT || typeof role.roleName !== "string")) {
        throw new Error("Unexpected personal-account role response.");
    }
    return JSON.stringify({ accountId: PERSONAL_ACCOUNT, roles: data.roleList.map((role) => role.roleName), moreResults: Boolean(data.nextToken) }, null, 2) + "\n";
}
