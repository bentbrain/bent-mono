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
test("Production storefront inspection reads only the exact project and exposes no arbitrary configuration", async () => {
    const result = await inspectProductionStorefront(env, async (url, init) => {
        assert.equal(url, `https://api.vercel.com/v9/projects/${env.VERCEL_PROJECT_ID}?teamId=${env.VERCEL_ORG_ID}`);
        assert.equal(init.method, undefined);
        assert.equal(init.redirect, "error");
        assert.equal(init.headers.Authorization, `Bearer ${env.VERCEL_TOKEN}`);
        return Response.json(project);
    });
    assert.equal(result.applicationMutations, false);
    assert.equal(result.nativePromotionReady, false);
    assert.equal(result.gitConnected, false);
    assert.equal(result.deployedSourceCommit, "b".repeat(40));
    assert.equal(JSON.stringify(result).includes("must-not-log"), false);
    assert.equal(JSON.stringify(result).includes(env.VERCEL_TOKEN), false);
});
test("an unlinked Vercel project may omit the optional Git link field", async () => {
    const unlinked = { ...project };
    delete unlinked.link;
    const result = await inspectProductionStorefront(env, async () => Response.json(unlinked));
    assert.equal(result.gitConnected, false);
});
test("storefront inspection rejects wrong contexts, Git auto-deploy and an unready or different project", async () => {
    for (const delta of [{ VERCEL_PROJECT_ID: "other" }, { VERCEL_ORG_ID: "work" }, { VERCEL_TOKEN: "" }, { GITHUB_REF: "refs/heads/other" }]) {
        await assert.rejects(inspectProductionStorefront({ ...env, ...delta }, () => assert.fail("No request before exact environment guard")));
    }
    for (const delta of [{ id: "other" }, { accountId: "work" }, { rootDirectory: "other" }, { link: { type: "github" } },
        { link: false }, { link: "" }, { link: [] },
        { targets: { production: { ...project.targets.production, readyState: "ERROR" } } },
        { targets: { production: { ...project.targets.production, alias: ["other.example"] } } }]) {
        await assert.rejects(inspectProductionStorefront(env, async () => Response.json({ ...project, ...delta })));
    }
});
