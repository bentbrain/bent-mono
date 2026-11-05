import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { browserCheckArgs, browserRuntimeKey } from "./check-browser.mjs";
test("browser cache identity separates Node, platform and hosted image changes", () => {
    const env = { ImageOS: "ubuntu24", ImageVersion: "20260901.1" };
    const runtime = { version: "v24.13.1", platform: "linux", arch: "x64" };
    const key = browserRuntimeKey(env, runtime);
    assert.equal(key, browserRuntimeKey({ ...env, GITHUB_SHA: "another-commit" }, runtime));
    for (const changed of [{ version: "v24.14.0" }, { platform: "darwin" }, { arch: "arm64" }]) {
        assert.notEqual(key, browserRuntimeKey(env, { ...runtime, ...changed }));
    }
    assert.notEqual(key, browserRuntimeKey({ ...env, ImageVersion: "20260908.1" }, runtime));
    assert.notEqual(key, browserRuntimeKey({ ...env, ImageOS: "ubuntu26" }, runtime));
    assert.notEqual(key, browserRuntimeKey({}, runtime));
});
test("browser caching uses only the checkout's scoped local cache and production builds force execution", () => {
    assert.deepEqual(browserCheckArgs({}), ["run", "turbo", "run", "test:e2e:local", "--filter=@forever-tee/web",
        "--cache-dir=.turbo/cache", "--cache=local:rw", "--summarize"]);
    assert.ok(browserCheckArgs({ E2E_LOCAL_PRODUCTION: "1" }).includes("--cache=local:w"));
    const fresh = browserCheckArgs({ CI_FRESH_VALIDATION: 'true', TURBO_TOKEN: 'untrusted', TURBO_TEAM: 'untrusted' });
    assert.ok(!fresh.includes('--force'));
    assert.ok(fresh.includes('--cache=local:w'));
    assert.ok(!fresh.some(value => value.includes('remote:')));
});
test("browser task covers fixtures, shared sources, dependency and workflow changes without caching live gates", () => {
    const config = JSON.parse(resolveProtectedTemplate(readFileSync(new URL("../turbo.shop-reference.json", import.meta.url), "utf8")));
    const browser = config.tasks["@forever-tee/web#test:e2e:local"];
    assert.deepEqual(browser.inputs, ["$TURBO_DEFAULT$", ".env*", "$TURBO_ROOT$/packages/**", "$TURBO_ROOT$/patches/**",
        "$TURBO_ROOT$/package.json", "$TURBO_ROOT$/bun.lock",
        "$TURBO_ROOT$/package.json", "$TURBO_ROOT$/workers/*/package.json",
        "$TURBO_ROOT$/scripts/check-browser.mjs", "$TURBO_ROOT$/scripts/task-runtime.mjs", "$TURBO_ROOT$/scripts/validation-environment.mjs",
        "$TURBO_ROOT$/.github/actions/check/**", ...["ci", "deploy", "native-development", "web-production"].map(name => `$TURBO_ROOT$/.github/workflows/${name}.yml`),
        "$TURBO_ROOT$/assets/lifestyle/**"]);
    assert.deepEqual(browser.env, ["CI", "CI_BROWSER_RUNTIME", "NODE_ENV", "NODE_OPTIONS", "PLAYWRIGHT_*", "E2E_LOCAL_PRODUCT_DEFAULT_COLOR", "E2E_LOCAL_PRODUCTION", "NEXT_PUBLIC_*", "LAN_DEV_ORIGIN"]);
    assert.deepEqual(browser.outputs, []);
    assert.equal(config.tasks["@forever-tee/web#test:e2e"], undefined);
    const manifest = JSON.parse(resolveProtectedTemplate(readFileSync(new URL("../package.json", import.meta.url), "utf8")));
    assert.equal(manifest.scripts["test:e2e:local"], "bun run --filter @forever-tee/web test:e2e:local");
    const action = readFileSync(new URL("../.github/actions/check/action.yml", import.meta.url), "utf8");
    assert.match(action, /run: bun run test:e2e:ci/);
    assert.ok(action.indexOf("run: bun run test:e2e:ci") < action.indexOf("run: bun run check:ci"));
    const deploy = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
    assert.match(deploy, /run: bun run --filter @forever-tee\/web test:e2e\n/);
});
test("Turbo resolves real browser inputs and invalidates fixture and runtime changes", () => {
    const dryRun = overrides => JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL("../../../node_modules/turbo/bin/turbo", import.meta.url)), "run", "test:e2e:local",
        "--filter=@forever-tee/web", "--cache=local:rw", "--dry=json"], {
        cwd: new URL("..", import.meta.url), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, TURBO_TEAM: "", TURBO_TOKEN: "", CI: "true", CI_BROWSER_RUNTIME: "fixture-runtime",
            E2E_LOCAL_PRODUCT_DEFAULT_COLOR: "Black", ...overrides },
    })).tasks[0];
    const initial = dryRun({});
    for (const path of ["scripts/local-browser.mjs", "e2e/local/preload.mjs", "e2e/local/artwork.png", "playwright.local.config.ts", "next.config.ts",
        "../../packages/contracts/src/index.ts", "../../../../bun.lock", "../../../../package.json",
        "../../scripts/check-browser.mjs", "../../assets/lifestyle/featured-blank-white.png", "../../.github/actions/check/action.yml", "../../workers/api/package.json"]) {
        assert.ok(initial.inputs[path], `missing browser input: ${path}`);
    }
    assert.ok(Object.keys(initial.inputs).some(path => path.startsWith("src/")));
    assert.ok(Object.keys(initial.inputs).some(path => path.startsWith("public/mockups/")));
    assert.ok(Object.keys(initial.inputs).some(path => path.startsWith("../../patches/")));
    assert.ok(!Object.keys(initial.inputs).some(path => path.startsWith("../../workers/api/src/") || path.startsWith("../../docs/")));
    assert.notEqual(initial.hash, dryRun({ E2E_LOCAL_PRODUCT_DEFAULT_COLOR: "White" }).hash);
    assert.notEqual(initial.hash, dryRun({ CI_BROWSER_RUNTIME: "different-runtime" }).hash);
});
test('remote browser cache is available only to first-attempt personal main dispatches', () => {
    const env = { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"),
        GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"), GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ATTEMPT: '1',
        TURBO_TOKEN: 'fixture', TURBO_TEAM: 'personal' };
    assert.ok(browserCheckArgs(env).includes('--cache=local:rw,remote:rw'));
    for (const override of [{ GITHUB_REF: 'refs/pull/1/merge' }, { GITHUB_EVENT_NAME: 'pull_request' },
        { GITHUB_REPOSITORY_ID: '1' }, { GITHUB_REPOSITORY_OWNER_ID: '1' }, { GITHUB_RUN_ATTEMPT: '2' },
        { GITHUB_ACTIONS: '' }, { TURBO_TOKEN: '' }, { TURBO_TEAM: '' }])
        assert.ok(browserCheckArgs({ ...env, ...override }).includes('--cache=local:rw'));
});
