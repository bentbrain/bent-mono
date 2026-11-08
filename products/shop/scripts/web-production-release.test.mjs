import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { assertWebOnlyProductionContext, executeWebOnlyPromotion, smokeStorefront, verifySocialCardImage, verifyWebOnlyStagedDeployment, } from "./web-production-release.mjs";
const commit = "a".repeat(40);
const runId = "12345";
const project = "prj_qJ3JwcSlVixLNHRxfwnvfxp8dMBS";
const team = "team_ru36uQa1rhHA6N5wW0lblUkz";
test("web-only Production requires the exact main-only first-attempt context", () => {
    const env = {
        FOREVER_TEE_API_SHARED_SECRET: "secret",
        FOREVER_TEE_API_URL: "https://worker.example",
        FOREVER_TEE_ENFORCE_WORKER_RELEASE: "1",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REF: "refs/heads/main",
        GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"),
        GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"),
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: runId,
        GITHUB_SHA: commit,
        VERCEL_ORG_ID: team,
        VERCEL_PROJECT_ID: project,
        VERCEL_TOKEN: "token",
        WEB_RELEASE_EVIDENCE_DIR: "/tmp/evidence",
    };
    assert.doesNotThrow(() => assertWebOnlyProductionContext(env, "linux"));
    for (const delta of [
        { GITHUB_REF: "refs/heads/feature" },
        { GITHUB_REPOSITORY_ID: "other" },
        { GITHUB_RUN_ATTEMPT: "2" },
        { GITHUB_EVENT_NAME: "push" },
        { VERCEL_ORG_ID: "work" },
        { FOREVER_TEE_ENFORCE_WORKER_RELEASE: "0" },
    ]) {
        assert.throws(() => assertWebOnlyProductionContext({ ...env, ...delta }, "linux"));
    }
});
test("staged deployment pins the project, run and unpromoted source", () => {
    const deployment = {
        alias: [],
        id: "dpl_staged",
        meta: {
            githubActionsRunId: runId,
            githubCommitSha: commit,
            webOnlyProductionSource: commit,
            shopArtworkMedia: "owner-artwork-media-v1",
        },
        projectId: project,
        readyState: "READY",
        source: "cli",
        target: "production",
        team: { id: team },
        url: "forever-tee-abc123-bentbrains-projects.vercel.app",
    };
    assert.equal(verifyWebOnlyStagedDeployment(deployment, commit, runId).id, "dpl_staged");
    for (const delta of [
        { alias: ["shop.bent.build"] },
        { projectId: "other" },
        { readyState: "BUILDING" },
        { source: "git" },
        { target: "preview" },
        { meta: { ...deployment.meta, githubActionsRunId: "999" } },
    ]) {
        assert.throws(() => verifyWebOnlyStagedDeployment({ ...deployment, ...delta }, commit, runId));
    }
});
async function storefrontFixture() {
    const requests = [];
    const featuredId = "d09442a5-74b9-43a7-9ec3-e14231dd7b07";
    const toteId = "8f615354-135e-4310-8d7b-3a2272b817d3";
    const productMarker = await sharp({
        create: {
            background: { alpha: 1, b: 0, g: 0, r: 255 },
            channels: 4,
            height: 100,
            width: 100,
        },
    }).png().toBuffer();
    const png = await sharp({
        create: {
            background: { alpha: 1, b: 255, g: 255, r: 255 },
            channels: 4,
            height: 630,
            width: 1200,
        },
    }).composite([{ input: productMarker, left: 800, top: 200 }]).png().toBuffer();
    const fetcher = async (url, options) => {
        requests.push({ path: `${url.pathname}${url.search}`, headers: options.headers });
        if (url.pathname === "/favicon.ico") {
            return new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "image/vnd.microsoft.icon" } });
        }
        if (url.pathname.startsWith("/api/social-card/")) {
            return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
        }
        if (["/social-card-tuner", "/story-video-tuner"].includes(url.pathname)) {
            return new Response("Not found", { status: 404 });
        }
        // The grid no longer emits variant metadata for legacy homepage queries.
        if (url.pathname === "/") {
            return new Response(`bent.shop products make your own /api/social-card/v4/featured/staple-tee/black.png <a href="/featured/${featuredId}">Current featured product</a>`, {
                status: 200, headers: { "content-type": "text/html" },
            });
        }
        if (url.pathname.startsWith("/featured/") && url.pathname !== `/featured/${featuredId}`) {
            return new Response("Not featured", { status: 404 });
        }
        assert.ok(url.pathname === `/featured/${featuredId}` || url.pathname === `/product/${featuredId}`);
        const productId = url.searchParams.get("product") === "tote" ? toteId : featuredId;
        const color = url.pathname.startsWith("/product/") ? "white" : "black";
        const image = `https://shop.bent.build/api/social-card/v4/product/${productId}/${color}.png`;
        return new Response(`make your own <meta property="og:image" content="${image}"/><meta name="twitter:image" content="${image}"/>`, {
            status: 200, headers: { "content-type": "text/html" },
        });
    };
    return { fetcher, requests, featuredId, toteId };
}
test("storefront smoke checks current featured metadata, removed tuners, favicon and final images", async () => {
    const { fetcher, requests, featuredId, toteId } = await storefrontFixture();
    const result = await smokeStorefront("https://staged.example", {
        bypass: "existing-automation-bypass",
        fetcher,
        includeImages: true,
    });
    assert.deepEqual(result, {
        faviconVerified: true,
        featuredProductId: featuredId,
        internalRoutesRemoved: 2,
        metadataVariants: 4,
        socialCardImages: 4,
    });
    assert.equal(requests.length, 11);
    assert.ok(requests.some(request => request.path === `/api/social-card/v4/product/${toteId}/black.png`));
    assert.ok(requests.some(request => request.path === `/api/social-card/v4/product/${featuredId}/white.png`));
    assert.ok(requests.some(request => request.path === "/"));
    assert.ok(requests.some(request => request.path === `/featured/${featuredId}?product=tote&toteColor=Black`));
    assert.ok(requests.every((request) => request.headers["x-vercel-protection-bypass"] === "existing-automation-bypass"));
});
test("storefront smoke rejects a missing selection, broken featured route and incorrect variant metadata", async () => {
    const cases = [
        { path: "/", change: () => new Response("bent.shop products make your own /api/social-card/v4/featured/staple-tee/black.png", { headers: { "content-type": "text/html" } }), error: /current featured selection/ },
        { path: "/featured/", change: () => new Response("Not found", { status: 404 }), error: /HTTP 404/ },
        { path: "/featured/", change: async (response) => new Response((await response.text()).replaceAll("/black.png", "/white.png"), { headers: response.headers }), error: /variant-aware social metadata/ },
        { path: "/featured/", change: async (response) => new Response((await response.text()).replace('name="twitter:image"', 'name="wrong"'), { headers: response.headers }), error: /matching social image metadata/ },
    ];
    for (const scenario of cases) {
        const fixture = await storefrontFixture();
        await assert.rejects(smokeStorefront("https://staged.example", {
            includeImages: false,
            fetcher: async (url, options) => {
                const response = await fixture.fetcher(url, options);
                return (scenario.path === "/" ? url.pathname === "/" : url.pathname.startsWith(scenario.path))
                    ? scenario.change(response) : response;
            },
        }), scenario.error);
    }
});
test("social card verification rejects a blank product panel", async () => {
    const blank = await sharp({
        create: {
            background: { alpha: 1, b: 255, g: 255, r: 255 },
            channels: 4,
            height: 630,
            width: 1200,
        },
    }).png().toBuffer();
    await assert.rejects(verifySocialCardImage(blank, "/blank.png"), /rendered product detail/);
});
function promotionFixture() {
    const events = [];
    let current = "dpl_previous";
    const args = {
        previous: { id: current, artworkMediaCapability: "owner-artwork-media-v1" },
        save: async (name) => events.push(name),
        verifyWorker: async () => events.push("worker"),
        deploy: async () => {
            events.push("deploy");
            return "https://staged.example";
        },
        inspectStaged: async () => ({ id: "dpl_staged", url: "https://staged.example" }),
        domain: async () => current,
        stagedSmoke: async () => {
            events.push("staged-smoke");
            return { metadataVariants: 3 };
        },
        promote: async (id) => {
            events.push(`promote:${id}`);
            current = id;
        },
        publicSmoke: async () => {
            events.push("public-smoke");
            return { socialCardImages: 4 };
        },
    };
    return { args, events, setCurrent: (value) => { current = value; } };
}
test("promotion verifies the Worker and staged storefront before changing the domain", async () => {
    const fixture = promotionFixture();
    const result = await executeWebOnlyPromotion(fixture.args);
    assert.equal(result.productionStorefrontReleased, true);
    assert.deepEqual(fixture.events, [
        "storefront-before.json",
        "worker",
        "storefront-build-intent.json",
        "deploy",
        "storefront-staged.json",
        "staged-smoke",
        "storefront-staged-smoke.json",
        "worker",
        "storefront-promote-intent.json",
        "promote:dpl_staged",
        "public-smoke",
        "worker",
        "storefront-complete.json",
    ]);
});
test("a failed public smoke restores the preserved deployment", async () => {
    const fixture = promotionFixture();
    fixture.args.publicSmoke = async () => {
        fixture.events.push("public-smoke");
        throw new Error("bad image");
    };
    await assert.rejects(executeWebOnlyPromotion(fixture.args), /bad image/);
    assert.deepEqual(fixture.events.slice(-4), [
        "public-smoke",
        "storefront-rollback-intent.json",
        "promote:dpl_previous",
        "storefront-rolled-back.json",
    ]);
});
test("an uncertain promotion response is inspected and never repeated", async () => {
    const fixture = promotionFixture();
    let promotions = 0;
    fixture.args.promote = async (id) => {
        promotions += 1;
        fixture.setCurrent(id);
        throw new Error("lost response");
    };
    const result = await executeWebOnlyPromotion(fixture.args);
    assert.equal(result.productionStorefrontReleased, true);
    assert.equal(promotions, 1);
});


test("promotion requires a compatible rollback before build or domain mutation", async () => {
    const fixture = promotionFixture();
    delete fixture.args.previous.artworkMediaCapability;
    await assert.rejects(executeWebOnlyPromotion(fixture.args), /Storefront rollback requires/);
    assert.deepEqual(fixture.events, []);
});
