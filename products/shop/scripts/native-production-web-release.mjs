import { REPOSITORY_ROOT, storefrontSourceManifest } from "./monorepo-source.mjs";
import { resolveProtectedTemplate } from "./protected-config.mjs";
import { execFile } from "node:child_process";
import { promisify, parseEnv } from "node:util";
import { readFile } from "node:fs/promises";
import { productionAWS, assertProductionContext } from "./native-production-ci.mjs";
import { productionCloudflare } from "./native-production-cloudflare.mjs";
import { productionReleaseStore } from "./native-production-release-store.mjs";
import { productionCanary } from "./native-production-canary.mjs";
import { verifyProductionPairStatus } from "./native-production-release.mjs";
const execute = promisify(execFile);
const PROJECT = "prj_qJ3JwcSlVixLNHRxfwnvfxp8dMBS", TEAM = "team_ru36uQa1rhHA6N5wW0lblUkz";
const API_ORIGIN = "https://forever-tee-api.socialqueue.workers.dev", SENSITIVE = "[SENSITIVE]";
const PRODUCTION_ENVIRONMENT = {
    FOREVER_TEE_API_SHARED_SECRET: { type: "sensitive", createdAt: 1786839353918, updatedAt: 1787466006947 },
    FOREVER_TEE_API_URL: { type: "encrypted", createdAt: 1786569311079, updatedAt: 1787465955772 },
    FOREVER_TEE_ENFORCE_WORKER_RELEASE: { type: "sensitive", createdAt: 1786842484938, updatedAt: 1786842484938 },
    NEXT_PUBLIC_FOREVER_TEE_API_URL: { type: "encrypted", createdAt: 1786569311079, updatedAt: 1787465958405 },
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: { type: "encrypted", createdAt: 1786839462886, updatedAt: 1786839462886 },
    TURNSTILE_SECRET: { type: "sensitive", createdAt: 1786839408060, updatedAt: 1786843550230 },
};
const check = (value, reason) => { if (!value)
    throw new Error(`Production storefront release stopped: ${reason}`); };
const deploymentURL = value => /^https:\/\/forever-tee-[a-z0-9]+-bentbrains-projects\.vercel\.app$/.test(value);
export function verifyWebProject(project) {
    check(project.id === PROJECT && project.accountId === TEAM && project.name === "forever-tee-web" && project.rootDirectory === "products/shop/apps/web" &&
        (project.link === null || project.link === undefined), "exact unlinked personal project/root.");
}
export function existingWebAutomationCredential(project) {
    verifyWebProject(project);
    const entries = Object.entries(project.protectionBypass ?? {}).filter(([, value]) => value?.scope === "automation-bypass");
    check(entries.length === 1 && /^[A-Za-z0-9_-]{16,256}$/.test(entries[0][0]), "one existing project automation credential required; no protection changes or new tokens.");
    return entries[0][0];
}
export function verifyStagedWebDeployment(value, commit) {
    check(/^dpl_[A-Za-z0-9]+$/.test(value.id) && value.projectId === PROJECT && value.team?.id === TEAM && value.target === "production" &&
        value.readyState === "READY" && value.meta?.githubCommitSha === commit && value.meta?.nativeProductionSource === commit &&
        value.source === "cli" && deploymentURL(`https://${value.url}`) && !value.alias?.includes("shop.bent.build"), "ready, unpromoted cloud build from exact source.");
    return { id: value.id, url: `https://${value.url}`, sourceCommit: commit };
}
export function verifyProductionWebEnvironmentMetadata(value) {
    check(Array.isArray(value?.envs), "Production environment metadata.");
    for (const [key, expected] of Object.entries(PRODUCTION_ENVIRONMENT)) {
        const matches = value.envs.filter(item => item.key === key && item.target?.includes("production"));
        check(matches.length === 1 && matches[0].type === expected.type && matches[0].target.length === 1 &&
            matches[0].createdAt === expected.createdAt && matches[0].updatedAt === expected.updatedAt && matches[0].configurationId === null, `pinned ${key} Production binding.`);
    }
    check(!value.envs.some(item => item.key === "TURNSTILE_TEST_MODE" && item.target?.includes("production")), "no Production Turnstile test binding.");
}
export function verifyProductionWebEnvironment(values, secret) {
    check(values.FOREVER_TEE_API_URL === API_ORIGIN && values.NEXT_PUBLIC_FOREVER_TEE_API_URL === API_ORIGIN &&
        [secret, SENSITIVE].includes(values.FOREVER_TEE_API_SHARED_SECRET) && ["1", SENSITIVE].includes(values.FOREVER_TEE_ENFORCE_WORKER_RELEASE), "actual Production Worker environment.");
    check(typeof values.NEXT_PUBLIC_TURNSTILE_SITE_KEY === "string" && values.NEXT_PUBLIC_TURNSTILE_SITE_KEY.length > 10 &&
        values.NEXT_PUBLIC_TURNSTILE_SITE_KEY !== SENSITIVE && !/^[123]x/.test(values.NEXT_PUBLIC_TURNSTILE_SITE_KEY) &&
        (values.TURNSTILE_SECRET === SENSITIVE || typeof values.TURNSTILE_SECRET === "string" && values.TURNSTILE_SECRET.length > 10 &&
            !/^[123]x/.test(values.TURNSTILE_SECRET)) && values.TURNSTILE_TEST_MODE === undefined, "real Production challenge configuration, no Preview test overrides.");
}
// A failed or uncertain write never reruns deploy/promote. Preserve the intent
// and inspect Vercel's deployment/domain state before a separate recovery.
export async function executeStorefrontPromotion({ previous, save, deploy, inspectStaged, domain, canary, verifyPair, promote, publicCheck }) {
    await save("storefront-before.json", previous);
    await verifyPair();
    await save("storefront-build-intent.json", { previousDeploymentId: previous.id });
    const staged = await inspectStaged(await deploy());
    await save("storefront-staged.json", staged);
    check(await domain() === previous.id, "public domain moved during the staged build.");
    const tested = await canary(staged.url);
    check(tested.productionCanaryPassed && tested.storefrontBffVerified && tested.videos === 4, "staged family/BFF qualification.");
    await verifyPair();
    check(await domain() === previous.id, "public domain changed before promotion.");
    await save("storefront-promote-intent.json", { previous, staged, canary: tested.evidence });
    await promote(staged.id);
    check(await domain() === staged.id, "promotion not confirmed; inspect domain before recovery.");
    await publicCheck(tested);
    const result = { productionStorefrontReleased: true, domain: "shop.bent.build", previous, staged, canary: tested.evidence };
    await save("storefront-complete.json", result);
    return result;
}
export async function releaseProductionStorefront(env) {
    assertProductionContext(env);
    check(env.NATIVE_OPERATION === "release-storefront" && process.platform === "linux" && env.VERCEL_PROJECT_ID === PROJECT && env.VERCEL_ORG_ID === TEAM &&
        env.VERCEL_TOKEN && /^native-[1-9][0-9]+$/.test(env.NATIVE_VERIFY_RELEASE ?? ""), "cloud-only exact project, credential and deployed release.");
    const { call } = await productionAWS(env), store = await productionReleaseStore(env, call), cf = productionCloudflare(env);
    const api = async (path) => {
        let response;
        try {
            response = await fetch(`https://api.vercel.com${path}${path.includes("?") ? "&" : "?"}teamId=${TEAM}`, {
                redirect: "error", signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${env.VERCEL_TOKEN}` },
            });
        }
        catch {
            throw new Error("Production Vercel read failed; response content omitted.");
        }
        check(response.ok, `Vercel read returned HTTP ${response.status}.`);
        return response.json();
    };
    const user = (await api("/v2/user")).user;
    check(user?.username === "bentbrain", "verified personal Vercel user.");
    const webProtectionBypass = existingWebAutomationCredential(await api(`/v9/projects/${PROJECT}`));
    verifyProductionWebEnvironmentMetadata(await api(`/v10/projects/${PROJECT}/env`));
    const domain = async () => {
        const alias = await api("/v4/aliases/shop.bent.build");
        check(alias.alias === "shop.bent.build" && alias.projectId === PROJECT && /^dpl_[A-Za-z0-9]+$/.test(alias.deploymentId), "exact live domain/project.");
        return alias.deploymentId;
    };
    const previousId = await domain(), old = await api(`/v13/deployments/${previousId}`);
    check(old.projectId === PROJECT && old.team?.id === TEAM && old.readyState === "READY" && old.target === "production" && /^[a-f0-9]{40}$/.test(old.meta?.githubCommitSha ?? ""), "existing recoverable Production build.");
    const releaseId = env.NATIVE_VERIFY_RELEASE;
    const rows = (await cf.query("SELECT stage,payload FROM native_video_release_events WHERE release_id=? AND stage IN ('verified','canary-verified')", [releaseId]))[0].results;
    check(rows.length === 2 && new Set(rows.map(row => row.stage)).size === 2, "completed pair and direct Production canary required.");
    const verified = JSON.parse(rows.find(row => row.stage === "verified").payload), canaryRecord = JSON.parse(rows.find(row => row.stage === "canary-verified").payload);
    const canaryEvidence = JSON.parse(await store.read(canaryRecord.evidence));
    check(canaryEvidence.productionCanaryPassed && canaryEvidence.releaseId === releaseId && canaryEvidence.sourceCommit === verified.sourceCommit && canaryEvidence.videos === 4, "immutable direct canary evidence.");
    const verifyPair = () => verifyProductionPairStatus(env, releaseId, verified.sourceCommit, false);
    // The CLI only receives its own scoped token, never AWS or Cloudflare keys.
    const cliEnv = { PATH: env.PATH, HOME: env.HOME, CI: "1", VERCEL_ORG_ID: TEAM, VERCEL_PROJECT_ID: PROJECT };
    const cli = async (args) => {
        try {
            return (await execute("bunx", ["vercel@59.5.0", ...args, `--token=${env.VERCEL_TOKEN}`], { cwd: REPOSITORY_ROOT, env: cliEnv, encoding: "utf8", timeout: 1200000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
        }
        catch {
            throw new Error("Production Vercel command failed or response uncertain; private command output omitted. Inspect the saved intent before recovery.");
        }
    };
    const status = await execute("git", ["status", "--porcelain", "--untracked-files=all"]);
    check(status.stdout.trim() === "", "clean CI source checkout required.");
    const commit = (await execute("git", ["rev-parse", "HEAD"])).stdout.trim();
    check(commit === env.GITHUB_SHA, "checked-out source commit.");
    const manifest = await storefrontSourceManifest();
    await store.save("storefront-source.json", Buffer.from(JSON.stringify({ sourceCommit: commit, files: manifest })));
    await cli(["pull", "--yes", "--environment=production"]);
    const linked = JSON.parse(resolveProtectedTemplate(await readFile(new URL("../../../.vercel/project.json", import.meta.url), "utf8")));
    check(linked.projectId === PROJECT && linked.orgId === TEAM, "CLI project linkage.");
    verifyProductionWebEnvironment(parseEnv(await readFile(new URL("../../../.vercel/.env.production.local", import.meta.url), "utf8")), env.FOREVER_TEE_API_SHARED_SECRET);
    return executeStorefrontPromotion({
        previous: { id: previousId, sourceCommit: old.meta.githubCommitSha },
        save: (name, value) => store.save(name, Buffer.from(JSON.stringify(value))), verifyPair, domain,
        deploy: async () => {
            const output = await cli(["deploy", "--prod", "--skip-domain", "--yes", "--meta", `githubCommitSha=${commit}`, "--meta", `nativeProductionSource=${commit}`]);
            check(deploymentURL(output), "single staged deployment URL; inspect intent if response differs.");
            return output;
        },
        inspectStaged: async (url) => verifyStagedWebDeployment(await api(`/v13/deployments/${new URL(url).hostname}`), commit),
        canary: webOrigin => productionCanary(env, { webOrigin, webProtectionBypass }),
        promote: id => cli(["promote", id, "--yes"]),
        publicCheck: async (tested) => {
            verifyWebProject(await api(`/v9/projects/${PROJECT}`));
            for (const product of tested.products) {
                const response = await fetch(`https://shop.bent.build/api/configured-product-video/${product}/black.mp4`, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(30000) });
                check(response.status === 200 && response.headers.get("content-type") === "video/mp4" && Number(response.headers.get("content-length")) > 0, "public-domain BFF video availability.");
            }
            await verifyPair();
        },
    });
}
