import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
// Deliberately fail closed until an approved personal-account CI role, remote
// state and immutable native release/rollback stage replace this guard.
export function requireSupportedRelease({ environment, apiChanged, lambdaChanged, bindings, plannedProvider = "cloudflare" }) {
    if (!["development", "production"].includes(environment) || !Array.isArray(bindings) ||
        typeof apiChanged !== "boolean" || typeof lambdaChanged !== "boolean" ||
        bindings.some(binding => !binding || typeof binding !== "object" || typeof binding.name !== "string")) {
        throw new Error("Invalid native release configuration.");
    }
    const providers = bindings.filter(binding => binding.name === "STORY_VIDEO_PROVIDER");
    if (providers.length > 1)
        throw new Error("Ambiguous live story video provider; release blocked.");
    const provider = providers[0];
    if (!["lambda", "cloudflare"].includes(plannedProvider))
        throw new Error("Unknown planned provider; release blocked.");
    if (provider && (provider.type !== "plain_text" || !["lambda", "cloudflare"].includes(provider.text))) {
        throw new Error("Unknown live story video provider; release blocked.");
    }
    // Development is our native test environment, even when temporarily paused
    // or rolled back. Production still uses Cloudflare until the explicit cutover.
    if ((environment === "development" || provider?.text === "lambda" || plannedProvider === "lambda") &&
        (apiChanged || lambdaChanged)) {
        throw new Error("Native Lambda release required. This workflow only deploys Wrangler. Complete the scoped personal-account native build, digest verification and rollback stage before releasing API or renderer changes.");
    }
}
export async function inspectNativeRelease(env, send = fetch) {
    const scripts = { development: "forever-tee-api-development", production: "forever-tee-api" };
    const script = Object.hasOwn(scripts, env.DEPLOY_ENV) ? scripts[env.DEPLOY_ENV] : undefined;
    if (!script || env.CLOUDFLARE_ACCOUNT_ID !== protectedConfig("cloudflareAccountId") || !env.CLOUDFLARE_API_TOKEN ||
        !["true", "false"].includes(env.API_CHANGED) || !["true", "false"].includes(env.LAMBDA_CHANGED))
        throw new Error("Missing native release gate configuration.");
    // This config uses whole-line comments only. Unsupported JSONC syntax fails
    // closed instead of guessing, before any deployment or secret mutation.
    const source = await readFile(new URL("../workers/api/wrangler.jsonc", import.meta.url), "utf8");
    const config = JSON.parse(resolveProtectedTemplate(source).replace(/^\s*\/\/.*$/gm, ""));
    const planned = config.env?.[env.DEPLOY_ENV];
    if (!planned?.vars)
        throw new Error("Missing planned Worker configuration.");
    const response = await send(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${script}/settings`, {
        headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }, redirect: "error", signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Cannot verify live provider; release blocked.");
    }
    const data = await response.json();
    if (data?.success !== true)
        throw new Error("Cannot verify live provider; release blocked.");
    requireSupportedRelease({ environment: env.DEPLOY_ENV, apiChanged: env.API_CHANGED === "true",
        lambdaChanged: env.LAMBDA_CHANGED === "true", bindings: data.result?.bindings,
        plannedProvider: planned.vars.STORY_VIDEO_PROVIDER ?? "cloudflare" });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    await inspectNativeRelease(process.env);
