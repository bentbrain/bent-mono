import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { inspectProductionStorefront } from "./native-production-storefront.mjs";
const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "bentbrain/bent-mono", GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"),
    GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"), GITHUB_REF: "refs/heads/main", GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "123",
    GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ATTEMPT: "1", GITHUB_WORKFLOW_REF: "bentbrain/bent-mono/.github/workflows/native-production-identity.yml@refs/heads/main",
    VERCEL_PROJECT_ID: "prj_qJ3JwcSlVixLNHRxfwnvfxp8dMBS", VERCEL_ORG_ID: "team_ru36uQa1rhHA6N5wW0lblUkz", VERCEL_TOKEN: "private-fixture-token" };
const project = { id: env.VERCEL_PROJECT_ID, accountId: env.VERCEL_ORG_ID, name: "forever-tee-web", rootDirectory: "products/shop/apps/web", link: null,
    env: [{ value: "must-not-log" }], targets: { production: { id: "dpl_fixture", target: "production", readyState: "READY", alias: ["shop.bent.build"],
            meta: { githubCommitSha: "b".repeat(40), privateMetadata: "must-not-log" } } } };
// The v4 alias response binds the canonical hostname to a project and deployment.
// Redirects and soft deletion use redirect and deletedAt; optional null fields may be absent.
const canonicalAlias = { alias: "shop.bent.build", projectId: project.id,
    deploymentId: project.targets.production.id, redirect: null, deletedAt: null, privateMetadata: "must-not-log" };
const projectURL = `https://api.vercel.com/v9/projects/${project.id}?teamId=${project.accountId}`;
const aliasURL = `https://api.vercel.com/v4/aliases/shop.bent.build?teamId=${project.accountId}`;
function provider({ projects = [project], aliases = [canonicalAlias], respond } = {}) {
    const reads = [];
    const counts = { project: 0, alias: 0 };
    return { reads, counts, request: async (url, init) => {
        assert.ok(url === projectURL || url === aliasURL, "only the two fixed, team-scoped Vercel endpoints");
        assert.equal(init.method, "GET");
        assert.equal(init.redirect, "error");
        assert.ok(init.signal instanceof AbortSignal);
        assert.equal(init.signal.aborted, false);
        assert.deepEqual(init.headers, { Authorization: `Bearer ${env.VERCEL_TOKEN}` });
        const resource = url === projectURL ? "project" : "alias";
        const index = counts[resource]++;
        reads.push(resource);
        if (respond) return respond(resource, index);
        const values = resource === "project" ? projects : aliases;
        return Response.json(values[Math.min(index, values.length - 1)]);
    } };
}
test("existing apps/web production root with empty embedded aliases uses the authoritative canonical alias", async () => {
    const existing = structuredClone(project);
    existing.rootDirectory = "apps/web";
    existing.targets.production.alias = [];
    delete existing.link;
    const api = provider({ projects: [existing] });
    const result = await inspectProductionStorefront(env, api.request);
    assert.equal(result.rootDirectory, "apps/web");
    assert.equal(result.domain, canonicalAlias.alias);
    assert.equal(result.deploymentId, canonicalAlias.deploymentId);
    assert.equal(result.nativePromotionReady, false);
    assert.deepEqual(api.counts, { project: 2, alias: 2 });
});
test("Production storefront inspection reads only the exact project and alias and exposes no arbitrary configuration", async t => {
    const timeouts = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    t.mock.method(AbortSignal, "timeout", milliseconds => { timeouts.push(milliseconds); return timeout(milliseconds); });
    const api = provider();
    const result = await inspectProductionStorefront(env, api.request);
    assert.deepEqual(result, { productionStorefrontInspected: true, projectId: project.id, teamId: project.accountId,
        rootDirectory: "products/shop/apps/web", gitConnected: false, deploymentId: project.targets.production.id,
        deployedSourceCommit: "b".repeat(40), domain: "shop.bent.build", inspectionSourceCommit: env.GITHUB_SHA,
        runId: env.GITHUB_RUN_ID, applicationMutations: false, nativePromotionReady: false });
    assert.deepEqual(api.reads, ["project", "alias", "project", "alias"]);
    assert.deepEqual(timeouts, [30000, 30000, 30000, 30000]);
    assert.equal(JSON.stringify(result).includes("must-not-log"), false);
    assert.equal(JSON.stringify(result).includes(env.VERCEL_TOKEN), false);
});
test("both inspection roots accept null or absent Git link and report the observed root", async () => {
    for (const rootDirectory of ["apps/web", "products/shop/apps/web"]) {
        for (const linkPresent of [true, false]) {
            const value = { ...project, rootDirectory };
            if (!linkPresent) delete value.link;
            const api = provider({ projects: [value] });
            const result = await inspectProductionStorefront(env, api.request);
            assert.equal(result.rootDirectory, rootDirectory);
            assert.equal(result.gitConnected, false);
            assert.equal(result.nativePromotionReady, false);
        }
    }
});
test("embedded aliases cannot establish or override the authoritative canonical domain", async () => {
    for (const alias of [[], undefined, ["other.example"]]) {
        const value = structuredClone(project);
        value.targets.production.alias = alias;
        const result = await inspectProductionStorefront(env, provider({ projects: [value] }).request);
        assert.equal(result.domain, "shop.bent.build");
    }
    await assert.rejects(inspectProductionStorefront(env, provider({ aliases: [{ ...canonicalAlias, deploymentId: "dpl_old" }] }).request),
        /canonical domain/);
});
test("storefront inspection rejects wrong credential and Actions contexts before any request", async () => {
    for (const delta of [{ VERCEL_PROJECT_ID: "other" }, { VERCEL_ORG_ID: "work" }, { VERCEL_TOKEN: "" },
        { VERCEL_TOKEN: undefined }, { GITHUB_ACTIONS: "false" }, { GITHUB_REPOSITORY: "other/repository" },
        { GITHUB_REPOSITORY_ID: "other" }, { GITHUB_REPOSITORY_OWNER_ID: "other" }, { GITHUB_REF: "refs/heads/other" },
        { GITHUB_EVENT_NAME: "push" }, { GITHUB_RUN_ATTEMPT: "2" }, { GITHUB_WORKFLOW_REF: "other" },
        { GITHUB_SHA: "invalid" }, { GITHUB_RUN_ID: "invalid" }]) {
        let calls = 0;
        await assert.rejects(inspectProductionStorefront({ ...env, ...delta }, () => { calls++; assert.fail("environment guard must precede reads"); }));
        assert.equal(calls, 0);
    }
});
const invalidProjects = [null, {}, { ...project, id: "other" }, { ...project, accountId: "work" }, { ...project, name: "other" },
    ...[undefined, null, "", "other", "apps/web/", "products/shop/apps/web/"].map(rootDirectory => ({ ...project, rootDirectory })),
    ...[{ type: "github" }, false, "", [], {}].map(link => ({ ...project, link }))];
test("storefront inspection rejects missing or foreign projects and roots and every active or malformed Git link", async () => {
    for (const value of invalidProjects) {
        const api = provider({ projects: [value] });
        await assert.rejects(inspectProductionStorefront(env, api.request), /project identity and inspection root|Git connection/);
        assert.deepEqual(api.reads, ["project"]);
    }
});
const invalidTargets = [undefined, null, {}, ...[
    { id: "other" }, { id: ["dpl_fixture"] }, { target: "preview" }, { readyState: "BUILDING" }, { readyState: "ERROR" },
    { meta: undefined }, { meta: { githubCommitSha: "invalid" } }, { meta: { githubCommitSha: ["b".repeat(40)] } },
].map(delta => ({ ...project.targets.production, ...delta }))];
test("storefront inspection requires a READY exact Production target and a valid source commit", async () => {
    for (const production of invalidTargets) {
        const api = provider({ projects: [{ ...project, targets: { production } }] });
        await assert.rejects(inspectProductionStorefront(env, api.request), /existing Production deployment and source/);
        assert.deepEqual(api.reads, ["project"]);
    }
});
const invalidAliases = [null, {}, ...[
    { alias: undefined }, { alias: "foreign.example" }, { alias: "shop.bent.build.evil.example" },
    { projectId: "prj_foreign" }, { projectId: undefined }, { deploymentId: "dpl_foreign" }, { deploymentId: undefined },
    { redirect: "https://foreign.example" }, { redirect: "" }, { redirect: false }, { deletedAt: 123 }, { deletedAt: 0 },
].map(delta => ({ ...canonicalAlias, ...delta }))];
test("canonical alias rejects wrong domain, project, stale or foreign deployment, redirects and deletion", async () => {
    for (const alias of invalidAliases) {
        const api = provider({ aliases: [alias] });
        await assert.rejects(inspectProductionStorefront(env, api.request), /canonical domain/);
        assert.deepEqual(api.reads, ["project", "alias"]);
    }
});
test("canonical alias may omit the optional redirect and deletion fields", async () => {
    const alias = { ...canonicalAlias };
    delete alias.redirect;
    delete alias.deletedAt;
    assert.equal((await inspectProductionStorefront(env, provider({ aliases: [alias] }).request)).productionStorefrontInspected, true);
});
test("each project and alias read fails closed on HTTP, transport, timeout or malformed JSON without exposing response content", async () => {
    const failures = [
        { respond: () => new Response("must-not-log", { status: 403 }), message: /HTTP 403/ },
        { respond: () => new Response("must-not-log", { status: 404 }), message: /HTTP 404/ },
        { respond: () => new Response("must-not-log", { status: 503 }), message: /HTTP 503/ },
        { respond: () => new Response(null, { status: 307, headers: { Location: "https://foreign.example" } }), message: /HTTP 307/ },
        { respond: () => { throw new Error(`must-not-log ${env.VERCEL_TOKEN}`); }, message: /Vercel read failed/ },
        { respond: () => { throw new DOMException("must-not-log", "TimeoutError"); }, message: /Vercel read failed/ },
        { respond: () => new Response(`must-not-log ${env.VERCEL_TOKEN}`), message: /not valid JSON/ },
    ];
    for (const resource of ["project", "alias"]) {
        for (const index of [0, 1]) {
            for (const failure of failures) {
                const api = provider({ respond: (kind, readIndex) => {
                    if (kind === resource && readIndex === index) return failure.respond();
                    return Response.json(kind === "project" ? project : canonicalAlias);
                } });
                await assert.rejects(inspectProductionStorefront(env, api.request), error => {
                    assert.match(error.message, failure.message);
                    assert.equal(error.message.includes("must-not-log"), false);
                    assert.equal(error.message.includes(env.VERCEL_TOKEN), false);
                    return true;
                });
                assert.equal(api.counts[resource], index + 1, "failed reads are never retried");
            }
        }
    }
});
test("repeated project reads reject identity, Git, root, target or source drift, including another otherwise valid root or deployment", async () => {
    const changedRoot = { ...project, rootDirectory: "apps/web" };
    const changedDeployment = structuredClone(project);
    changedDeployment.targets.production.id = "dpl_new";
    const changedSource = structuredClone(project);
    changedSource.targets.production.meta.githubCommitSha = "c".repeat(40);
    for (const value of [...invalidProjects, ...invalidTargets.map(production => ({ ...project, targets: { production } })),
        changedRoot, changedDeployment, changedSource]) {
        const api = provider({ projects: [project, value] });
        await assert.rejects(inspectProductionStorefront(env, api.request), /inspection stopped/);
        assert.deepEqual(api.reads, ["project", "alias", "project"]);
    }
});
test("repeated canonical alias read rejects relevant drift even when embedded aliases still claim the domain", async () => {
    for (const alias of invalidAliases) {
        const api = provider({ aliases: [canonicalAlias, alias] });
        await assert.rejects(inspectProductionStorefront(env, api.request), /canonical domain/);
        assert.deepEqual(api.reads, ["project", "alias", "project", "alias"]);
    }
});
test("unrelated project settings and metadata may change without entering the safe inspection result", async () => {
    const repeated = structuredClone(project);
    delete repeated.link;
    repeated.env = [{ value: "must-not-log-changed" }];
    repeated.targets.production.alias = [];
    repeated.targets.production.meta.privateMetadata = "must-not-log-changed";
    const alias = { ...canonicalAlias, privateMetadata: "must-not-log-changed" };
    const result = await inspectProductionStorefront(env, provider({ projects: [project, repeated], aliases: [canonicalAlias, alias] }).request);
    assert.equal(result.productionStorefrontInspected, true);
    assert.equal(JSON.stringify(result).includes("must-not-log"), false);
});
