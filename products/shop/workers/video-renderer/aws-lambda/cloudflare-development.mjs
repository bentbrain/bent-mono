import { protectedConfig } from "./protected-config.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ROOT } from "./local-tools.mjs";
const CF_ACCOUNT = protectedConfig("cloudflareAccountId");
export const API_ORIGIN = "https://forever-tee-api-development.socialqueue.workers.dev";
export const DEVELOPMENT_DB = protectedConfig("resource_fb377032d2f5");
export const DEVELOPMENT_QUEUE = protectedConfig("resource_66448984d52e");
export async function cloudflareDevelopment() {
    const { stdout } = await promisify(execFile)("bun", ["--filter", "@forever-tee/api", "exec", "wrangler", "auth", "token", "--json"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 });
    const { token } = JSON.parse(stdout);
    if (typeof token !== "string" || !token)
        throw new Error("Cloudflare login required.");
    return async (path, body, method = body ? "POST" : "GET") => {
        const allowed = path.startsWith("/workers/scripts/forever-tee-api-development/") ||
            path === `/d1/database/${DEVELOPMENT_DB}/query` || path === `/queues/${DEVELOPMENT_QUEUE}` ||
            path === `/queues/${DEVELOPMENT_QUEUE}/messages`;
        if (!allowed)
            throw new Error("Only development video resources may be accessed.");
        const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}${path}`, {
            method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
        });
        const result = await response.json();
        if (!response.ok || !result.success)
            throw new Error(`Development Cloudflare request failed (${response.status}).`);
        return result.result;
    };
}
