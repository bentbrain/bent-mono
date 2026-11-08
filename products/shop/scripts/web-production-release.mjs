import { ARTWORK_MEDIA_CAPABILITY, assertArtworkMediaWeb } from "./artwork-media-compatibility.mjs";
import { REPOSITORY_ROOT, storefrontSourceManifest } from "./monorepo-source.mjs";
import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify, parseEnv } from "node:util";
import sharp from "sharp";
import { enforceWorkerRelease } from "../apps/web/scripts/verify-worker-release.mjs";
import { existingWebAutomationCredential, verifyProductionWebEnvironment, verifyProductionWebEnvironmentMetadata, verifyWebProject, } from "./native-production-web-release.mjs";
import { summary } from "./github-actions.mjs";
const execute = promisify(execFile);
const PROJECT = "prj_qJ3JwcSlVixLNHRxfwnvfxp8dMBS";
const TEAM = "team_ru36uQa1rhHA6N5wW0lblUkz";
const REPOSITORY_ID = protectedConfig("githubRepositoryId");
const OWNER_ID = protectedConfig("githubOwnerId");
const PUBLIC_ORIGIN = "https://shop.bent.build";
const check = (value, reason) => {
    if (!value)
        throw new Error(`Web-only Production release stopped: ${reason}`);
};
export function assertWebOnlyProductionContext(env, platform = process.platform) {
    check(platform === "linux" &&
        env.GITHUB_REPOSITORY_ID === REPOSITORY_ID &&
        env.GITHUB_REPOSITORY_OWNER_ID === OWNER_ID &&
        env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
        env.GITHUB_REF === "refs/heads/main" &&
        env.GITHUB_RUN_ATTEMPT === "1" &&
        /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") &&
        /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? ""), "exact main-only first-attempt workflow context.");
    check(env.VERCEL_PROJECT_ID === PROJECT &&
        env.VERCEL_ORG_ID === TEAM &&
        typeof env.VERCEL_TOKEN === "string" &&
        env.VERCEL_TOKEN.length > 0 &&
        env.FOREVER_TEE_ENFORCE_WORKER_RELEASE === "1" &&
        /^https:\/\//.test(env.FOREVER_TEE_API_URL ?? "") &&
        typeof env.FOREVER_TEE_API_SHARED_SECRET === "string" &&
        env.FOREVER_TEE_API_SHARED_SECRET.length > 0 &&
        env.WEB_RELEASE_EVIDENCE_DIR?.startsWith("/"), "exact Production project, Worker and evidence configuration.");
}
export function verifyWebOnlyStagedDeployment(value, commit, runId) {
    check(/^dpl_[A-Za-z0-9]+$/.test(value.id) &&
        value.projectId === PROJECT &&
        value.team?.id === TEAM &&
        value.target === "production" &&
        value.readyState === "READY" &&
        value.source === "cli" &&
        value.meta?.githubCommitSha === commit &&
        value.meta?.webOnlyProductionSource === commit &&
        value.meta?.shopArtworkMedia === ARTWORK_MEDIA_CAPABILITY &&
        value.meta?.githubActionsRunId === runId &&
        /^forever-tee-[a-z0-9]+-bentbrains-projects\.vercel\.app$/.test(value.url) &&
        !value.alias?.includes("shop.bent.build"), "ready, unpromoted deployment from the exact Actions run and source.");
    return { id: value.id, sourceCommit: commit, url: `https://${value.url}`, artworkMediaCapability: ARTWORK_MEDIA_CAPABILITY };
}
export async function smokeStorefront(origin, { bypass, includeImages, fetcher = fetch } = {}) {
    check(/^https:\/\/[a-z0-9.-]+$/.test(origin), "HTTPS storefront smoke origin.");
    const request = async (path, timeout = 30000) => {
        const headers = { "user-agent": "Twitterbot/1.0" };
        if (bypass)
            headers["x-vercel-protection-bypass"] = bypass;
        const response = await fetcher(new URL(path, origin), {
            headers,
            redirect: "error",
            signal: AbortSignal.timeout(timeout),
        });
        check(response.status === 200, `${path} returned HTTP ${response.status}.`);
        return response;
    };
    const readHtml = async (path) => {
        const response = await request(path);
        check(response.headers.get("content-type")?.includes("text/html"), `${path} HTML content type.`);
        const html = await response.text();
        check(html.includes("make your own"), `${path} storefront content.`);
        return html;
    };
    const home = await readHtml("/");
    check(home.includes("bent.shop products") && home.includes("/api/social-card/v4/featured/staple-tee/black.png"), "homepage product grid and social metadata.");
    const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
    const featuredIds = [...new Set([...home.matchAll(new RegExp(`<a\\b[^>]*\\bhref="/featured/(${uuid})"`, "g"))].map(match => match[1]))];
    check(featuredIds.length >= 1 && featuredIds.length <= 6, "homepage must link a bounded current featured selection.");
    const featuredProductId = featuredIds[0];
    const featuredCard = async (product, slug) => {
        const path = `/featured/${featuredProductId}?product=${product}&${product}Color=Black`;
        const html = await readHtml(path);
        const meta = name => {
            const tag = html.match(new RegExp(`<meta\\b[^>]*(?:property|name)="${name}"[^>]*>`))?.[0];
            return tag?.match(/\bcontent="([^"]+)"/)?.[1];
        };
        const og = meta("og:image"), twitter = meta("twitter:image");
        check(og && og === twitter, `${path} matching social image metadata.`);
        const url = new URL(og);
        check(url.origin === PUBLIC_ORIGIN && !url.search && !url.hash, `${path} first-party social image.`);
        const configured = url.pathname.match(new RegExp(`^/api/social-card/v4/product/(${uuid})/black\\.png$`));
        check(configured || url.pathname === `/api/social-card/v4/featured/${slug}/black.png`, `${path} variant-aware social metadata.`);
        return { path: url.pathname, productId: configured?.[1] ?? featuredProductId };
    };
    const shirt = await featuredCard("shirt", "staple-tee");
    const tote = await featuredCard("tote", "cotton-tote");
    check(shirt.path !== tote.path, "shirt and tote must use distinct social images.");
    const productPath = `/product/${shirt.productId}?Color=White`;
    check((await readHtml(productPath)).includes(`/api/social-card/v4/product/${shirt.productId}/white.png`), `${productPath} variant-aware social metadata.`);
    const favicon = await request("/favicon.ico");
    check(favicon.headers.get("content-type")?.includes("icon") &&
        (await favicon.arrayBuffer()).byteLength > 0, "favicon response.");
    const removedInternalRoutes = [
        "/social-card-tuner",
        "/story-video-tuner",
    ];
    for (const path of removedInternalRoutes) {
        const headers = { "user-agent": "Twitterbot/1.0" };
        if (bypass)
            headers["x-vercel-protection-bypass"] = bypass;
        const response = await fetcher(new URL(path, origin), {
            headers,
            redirect: "error",
            signal: AbortSignal.timeout(30000),
        });
        check(response.status === 404, `${path} remained publicly reachable.`);
    }
    const imagePaths = includeImages
        ? [
            shirt.path,
            shirt.path.replace(/black\.png$/, "white.png"),
            tote.path,
            tote.path.replace(/black\.png$/, "cream.png"),
        ]
        : [];
    for (const path of imagePaths) {
        const response = await request(path, 60000);
        check(response.headers.get("content-type") === "image/png", `${path} PNG content type.`);
        await verifySocialCardImage(await response.arrayBuffer(), path);
    }
    return {
        faviconVerified: true,
        featuredProductId,
        internalRoutesRemoved: removedInternalRoutes.length,
        metadataVariants: 4,
        socialCardImages: imagePaths.length,
    };
}
export async function executeWebOnlyPromotion({ previous, save, verifyWorker, deploy, inspectStaged, domain, stagedSmoke, promote, publicSmoke, }) {
    assertArtworkMediaWeb(previous);
    await save("storefront-before.json", previous);
    await verifyWorker();
    await save("storefront-build-intent.json", { previousDeploymentId: previous.id });
    const staged = await inspectStaged(await deploy());
    await save("storefront-staged.json", staged);
    check((await domain()) === previous.id, "public domain changed during the staged build.");
    const stagedResult = await stagedSmoke(staged.url);
    await save("storefront-staged-smoke.json", stagedResult);
    await verifyWorker();
    check((await domain()) === previous.id, "public domain changed before promotion.");
    await save("storefront-promote-intent.json", { previous, staged });
    try {
        await promote(staged.id);
    }
    catch (error) {
        if ((await domain()) !== staged.id)
            throw error;
    }
    check((await domain()) === staged.id, "promotion not confirmed.");
    try {
        const publicResult = await publicSmoke();
        await verifyWorker();
        const result = {
            productionStorefrontReleased: true,
            domain: "shop.bent.build",
            previous,
            publicSmoke: publicResult,
            staged,
            stagedSmoke: stagedResult,
        };
        await save("storefront-complete.json", result);
        return result;
    }
    catch (error) {
        await save("storefront-rollback-intent.json", { previous, staged });
        try {
            await promote(previous.id);
        }
        catch (rollbackError) {
            if ((await domain()) !== previous.id)
                throw rollbackError;
        }
        check((await domain()) === previous.id, "rollback to the preserved deployment was not confirmed.");
        await save("storefront-rolled-back.json", { previous, staged });
        throw error;
    }
}
export async function releaseWebOnlyProduction(env = process.env) {
    assertWebOnlyProductionContext(env);
    const evidenceDirectory = env.WEB_RELEASE_EVIDENCE_DIR;
    await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
    const save = async (name, value) => {
        check(/^[a-z0-9-]+\.json$/.test(name), "bounded evidence file name.");
        await writeFile(`${evidenceDirectory}/${name}`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    };
    const api = async (path) => {
        let response;
        try {
            response = await fetch(`https://api.vercel.com${path}${path.includes("?") ? "&" : "?"}teamId=${TEAM}`, {
                headers: { Authorization: `Bearer ${env.VERCEL_TOKEN}` },
                redirect: "error",
                signal: AbortSignal.timeout(30000),
            });
        }
        catch {
            throw new Error("Web-only Production Vercel read failed; response content omitted.");
        }
        check(response.ok, `Vercel read returned HTTP ${response.status}.`);
        return response.json();
    };
    const user = (await api("/v2/user")).user;
    check(user?.username === "bentbrain", "verified personal Vercel user.");
    const project = await api(`/v9/projects/${PROJECT}`);
    verifyWebProject(project);
    const bypass = existingWebAutomationCredential(project);
    verifyProductionWebEnvironmentMetadata(await api(`/v10/projects/${PROJECT}/env`));
    const domain = async () => {
        const alias = await api("/v4/aliases/shop.bent.build");
        check(alias.alias === "shop.bent.build" &&
            alias.projectId === PROJECT &&
            /^dpl_[A-Za-z0-9]+$/.test(alias.deploymentId), "exact live domain and project.");
        return alias.deploymentId;
    };
    const previousId = await domain();
    const old = await api(`/v13/deployments/${previousId}`);
    check(old.projectId === PROJECT &&
        old.team?.id === TEAM &&
        old.readyState === "READY" &&
        old.target === "production" &&
        /^[a-f0-9]{40}$/.test(old.meta?.githubCommitSha ?? ""), "existing recoverable Production deployment.");
    const commit = env.GITHUB_SHA;
    check(old.meta.githubCommitSha !== commit, "this source commit is already live.");
    const recent = await api(`/v6/deployments?projectId=${PROJECT}&target=production&limit=20`);
    check(Array.isArray(recent.deployments), "recent Vercel deployments.");
    check(!recent.deployments.some((deployment) => deployment.uid !== previousId &&
        deployment.meta?.webOnlyProductionSource === commit), "an unpromoted deployment already exists for this source; recover it instead of creating another.");
    const verifyWorker = () => enforceWorkerRelease({
        enforcement: env.FOREVER_TEE_ENFORCE_WORKER_RELEASE,
        apiUrl: env.FOREVER_TEE_API_URL,
        sharedSecret: env.FOREVER_TEE_API_SHARED_SECRET,
    });
    const status = await execute("git", ["status", "--porcelain", "--untracked-files=all"]);
    check(status.stdout.trim() === "", "clean CI source checkout required.");
    const head = (await execute("git", ["rev-parse", "HEAD"])).stdout.trim();
    check(head === commit, "checked-out source commit.");
    const manifest = await storefrontSourceManifest();
    await save("storefront-source.json", { files: manifest, sourceCommit: commit });
    const cliEnv = {
        CI: "1",
        HOME: env.HOME,
        PATH: env.PATH,
        VERCEL_ORG_ID: TEAM,
        VERCEL_PROJECT_ID: PROJECT,
    };
    const cli = async (args) => {
        try {
            return (await execute("bunx", ["vercel@59.5.0", ...args, `--token=${env.VERCEL_TOKEN}`], { cwd: REPOSITORY_ROOT, encoding: "utf8", env: cliEnv, maxBuffer: 4 * 1024 * 1024, timeout: 1200000 })).stdout.trim();
        }
        catch {
            throw new Error("Web-only Production Vercel command failed or returned an uncertain response. Inspect the saved evidence before recovery.");
        }
    };
    await cli(["pull", "--yes", "--environment=production"]);
    const linked = JSON.parse(resolveProtectedTemplate(await readFile(new URL("../../../.vercel/project.json", import.meta.url), "utf8")));
    check(linked.projectId === PROJECT && linked.orgId === TEAM, "CLI project linkage.");
    verifyProductionWebEnvironment(parseEnv(await readFile(new URL("../../../.vercel/.env.production.local", import.meta.url), "utf8")), env.FOREVER_TEE_API_SHARED_SECRET);
    const previous = { id: previousId, sourceCommit: old.meta.githubCommitSha, artworkMediaCapability: old.meta.shopArtworkMedia };
    const result = await executeWebOnlyPromotion({
        previous,
        save,
        verifyWorker,
        domain,
        deploy: async () => {
            const url = await cli([
                "deploy",
                "--prod",
                "--skip-domain",
                "--yes",
                "--meta",
                `githubCommitSha=${commit}`,
                "--meta",
                `webOnlyProductionSource=${commit}`,
                "--meta",
                `shopArtworkMedia=${ARTWORK_MEDIA_CAPABILITY}`,
                "--meta",
                `githubActionsRunId=${env.GITHUB_RUN_ID}`,
            ]);
            check(/^https:\/\/forever-tee-[a-z0-9]+-bentbrains-projects\.vercel\.app$/.test(url), "single staged deployment URL.");
            return url;
        },
        inspectStaged: async (url) => verifyWebOnlyStagedDeployment(await api(`/v13/deployments/${new URL(url).hostname}`), commit, env.GITHUB_RUN_ID),
        stagedSmoke: (origin) => smokeStorefront(origin, { bypass, includeImages: false }),
        promote: (id) => cli(["promote", id, "--yes"]),
        publicSmoke: () => smokeStorefront(PUBLIC_ORIGIN, { includeImages: true }),
    });
    summary(`### Web-only Production release\n${result.staged.url}\n\nPromoted to ${PUBLIC_ORIGIN} from ${commit}.`);
    return result;
}
export async function verifySocialCardImage(buffer, path) {
    const image = sharp(new Uint8Array(buffer));
    const metadata = await image.metadata();
    check(metadata.format === "png" && metadata.width === 1200 && metadata.height === 630, `${path} PNG dimensions.`);
    const panel = await image
        .extract({ height: 510, left: 620, top: 60, width: 520 })
        .stats();
    check(panel.channels.slice(0, 3).some((channel) => channel.mean < 250 || channel.stdev > 1), `${path} rendered product detail.`);
}
if (import.meta.main) {
    try {
        console.info(JSON.stringify(await releaseWebOnlyProduction()));
    }
    catch (error) {
        console.error(error instanceof Error ? error.message : "Web-only Production release failed.");
        process.exitCode = 1;
    }
}
