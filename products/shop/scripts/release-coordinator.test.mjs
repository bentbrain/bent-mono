import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { advanceCoordinator, coordinatedRunTitle, createCoordinator, verifyCoordinatedRun } from "./release-coordinator.mjs";
import { verifyDispatchSource } from "./release-dispatch-guard.mjs";
const source = "a".repeat(40), id = "12345678-1234-1234-1234-123456789abc";
function fixture(target = "preview", policyVersion = 2) {
    const journal = createCoordinator({ source, id, target, policyVersion });
    const runs = [], posts = [], saves = [];
    const deps = { save: async (value) => { saves.push(structuredClone(value)); }, preflight: async () => ({ passed: true }),
        api: async (path, body) => {
            if (path === "branches/main")
                return { commit: { sha: source } };
            if (body) {
                const index = posts.length;
                assert.equal(saves.at(-1).stages[index].status, "dispatching", "durable intent precedes dispatch");
                posts.push(body);
                runs.push({ id: 100 + index, repository: { id: Number(protectedConfig("githubRepositoryId")), owner: { id: Number(protectedConfig("githubOwnerId")) } }, head_repository: { id: Number(protectedConfig("githubRepositoryId")) },
                    head_sha: source, head_branch: "main", path: `.github/workflows/${journal.stages[index].workflow}`, event: "workflow_dispatch", run_attempt: 1,
                    display_title: coordinatedRunTitle(journal, index), status: "completed", conclusion: "success" });
                return;
            }
            if (path.startsWith("actions/runs/"))
                return runs.find(run => run.id === Number(path.split("/").at(-1)));
            return { workflow_runs: runs.filter(run => path.includes(run.path.split("/").at(-1))) };
        } };
    return { journal, deps, runs, posts, saves };
}
test("legacy journals still sequence release, full qualification and Preview with the actual released pair", async () => {
    const f = fixture("preview", 1);
    let result;
    for (let i = 0; i < 4; i++)
        result = await advanceCoordinator(f.journal, f.deps);
    assert.equal(result.state, "complete");
    assert.equal(f.posts.length, 3);
    assert.equal(f.posts[1].inputs.verify_release, "native-100");
    assert.equal(f.posts[2].inputs.web_only_preview, true);
    assert.ok(f.posts.every(post => post.ref === "main" && post.inputs.expected_source === source));
    assert.match(result.next, /owner phone acceptance/);
});
test("production is a distinct reviewed promotion followed by storefront deployment", async () => {
    const f = fixture("production");
    for (let i = 0; i < 3; i++)
        await advanceCoordinator(f.journal, f.deps);
    assert.equal(f.posts.length, 2);
    assert.equal(f.posts[0].inputs.operation, "promote");
});
test("lost dispatch response resumes by correlation and never repeats the POST", async () => {
    const f = fixture(), original = f.deps.api;
    f.deps.api = async (path, body) => { const result = await original(path, body); if (body)
        throw Error("response lost"); return result; };
    assert.equal((await advanceCoordinator(f.journal, f.deps)).state, "dispatch-uncertain");
    assert.equal(f.posts.length, 1);
    f.deps.api = original;
    await advanceCoordinator(f.journal, f.deps);
    assert.equal(f.posts.length, 2);
    assert.equal(f.posts[1].inputs.web_only_preview, true);
});
test("crash after intent and no visible run never causes another dispatch", async () => {
    const f = fixture();
    f.journal.stages[0].status = "dispatching";
    assert.equal((await advanceCoordinator(f.journal, f.deps)).state, "dispatch-uncertain");
    assert.equal(f.posts.length, 0);
});
test("failed or rerun releases, wrong sources and duplicate correlation stop coordination", async () => {
    for (const mutate of [f => { f.runs[0].conclusion = "failure"; }, f => { f.runs[0].run_attempt = 2; },
        f => { f.runs[0].head_sha = "b".repeat(40); }, f => { f.runs[0].display_title = f.runs[0].display_title.replace("release · full", "plan · full"); }, f => { f.runs.push({ ...f.runs[0], id: 500 }); }]) {
        const f = fixture();
        await advanceCoordinator(f.journal, f.deps);
        mutate(f);
        try {
            assert.equal((await advanceCoordinator(f.journal, f.deps)).state, "failed");
        }
        catch (error) {
            assert.match(error.message, /coordinator stopped/);
        }
        assert.equal(f.posts.length, 1);
    }
});
test("preflight failures, source races, modified plans and failed intent persistence cannot dispatch", async () => {
    const f = fixture();
    f.deps.preflight = async () => ({ passed: false, checks: [{ id: "source", passed: false }] });
    assert.equal((await advanceCoordinator(f.journal, f.deps)).state, "blocked");
    assert.equal(f.posts.length, 0);
    for (const mutate of [f => { f.deps.api = async () => ({ commit: { sha: "other" } }); },
        f => { f.journal.stages[0].inputs.operation = "rollback"; }, f => { f.deps.save = async () => { throw Error("disk full"); }; }]) {
        const g = fixture();
        mutate(g);
        await assert.rejects(advanceCoordinator(g.journal, g.deps));
        assert.equal(g.posts.length, 0);
    }
});
test("source guard closes the branch movement race and rejects coordinated reruns", () => {
    const env = { GITHUB_SHA: source, GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ATTEMPT: "1",
        RELEASE_EXPECTED_SOURCE: source, RELEASE_COORDINATION_ID: `release-${id}-0` };
    verifyDispatchSource(env);
    for (const changed of [{ GITHUB_SHA: "b".repeat(40) }, { GITHUB_RUN_ATTEMPT: "2" }, { RELEASE_EXPECTED_SOURCE: "" }]) {
        assert.throws(() => verifyDispatchSource({ ...env, ...changed }));
    }
    assert.throws(() => verifyCoordinatedRun({}, createCoordinator({ source, target: "preview" }), 0));
});
test("workflow run titles match discovery for every coordinated stage and mode", () => {
    for (const target of ["preview", "production"])
        for (const mode of ["full", "api"]) {
            const journal = createCoordinator({ source, id, target, mode });
            journal.stages[0].runId = 123;
            journal.stages.forEach((stage, index) => {
                const workflow = readFileSync(new URL(`../.github/workflows/${stage.workflow}`, import.meta.url), "utf8");
                const inputs = { force_full: false, ...stage.inputs, coordination_id: `release-${id}-${index}`,
                    ...(stage.inputs.operation === "qualify-all" ? { verify_release: "native-123" } : {}) };
                const title = /^run-name: (.+)$/m.exec(workflow)[1].replace(/\$\{\{ (.*?) \}\}/g, (_match, expression) => {
                    const [key, fallback] = expression.split(" || ");
                    if (key === "github.ref_name")
                        return "main";
                    if (key === "github.sha")
                        return source;
                    const value = inputs[key.replace("inputs.", "")];
                    return value || (fallback ? fallback.slice(1, -1) : String(value));
                });
                assert.equal(title, coordinatedRunTitle(journal, index));
                assert.match(workflow, /run: node scripts\/release-dispatch-guard\.mjs/);
            });
        }
});
test("the pre-install guard executes as a command and fails a stale source", () => {
    const result = spawnSync(process.execPath, [new URL("./release-dispatch-guard.mjs", import.meta.url).pathname], {
        env: { RELEASE_EXPECTED_SOURCE: source, GITHUB_SHA: "b".repeat(40), GITHUB_REF: "refs/heads/main" }, encoding: "utf8"
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Dispatched source differs/);
});
test('auto mode cannot silently omit a changed storefront or accept an edited selection', async () => {
    const { componentReleasePlan } = await import('./release-components.mjs');
    const changes = () => ['apps/web/src/app/page.tsx'];
    const baselines = { web: null, native: null };
    const selection = componentReleasePlan({ source, target: 'preview', baselines, changes });
    const journal = createCoordinator({ source, id, target: 'preview', mode: 'auto', selection });
    journal.selection.stages.pop();
    journal.stages.pop();
    await assert.rejects(advanceCoordinator(journal, { changes, api: async () => { throw Error('must not dispatch'); } }), /selection was changed/);
});
test('a no-op auto plan still verifies live baseline before claiming completion', async () => {
    const { componentReleasePlan } = await import('./release-components.mjs');
    const changes = () => [];
    const baseline = { source, runId: 123, deploymentId: 456 };
    const selection = componentReleasePlan({ source, target: 'preview', baselines: { web: baseline, native: baseline }, changes });
    const journal = createCoordinator({ source, id, target: 'preview', mode: 'auto', selection });
    assert.equal(journal.stages.length, 0);
    await assert.rejects(advanceCoordinator(journal, { changes, api: async () => [] }), /baseline changed/);
});
test('cleanup recovery has its own durable dispatch and never repeats successful rendering stages', async () => {
    const journal = createCoordinator({ source, id, target: 'preview', policyVersion: 1 }), runs = [], posts = [], saves = [];
    let loseCleanupResponse = true;
    const deps = { save: async (value) => saves.push(structuredClone(value)), preflight: async () => ({ passed: true }),
        recoverReference: async (runId, releaseId) => ({ key: "source/releases/native-" + protectedConfig("resource_8d0190ecec7d") + "/qualification-complete-summary-" + (releaseId) + "-run-" + (runId) + ".json", version: 'version', sha256: 'b'.repeat(64) }),
        api: async (path, body) => {
            if (path === 'branches/main')
                return { commit: { sha: source } };
            if (body) {
                const cleanup = body.inputs.operation === 'cleanup-qualification';
                const active = cleanup ? journal.stages[1].recovery : journal;
                const index = Number(body.inputs.coordination_id.split('-').at(-1));
                assert.equal(active.stages[index].status, 'dispatching');
                posts.push(body.inputs.operation ?? 'web');
                runs.push({ id: 100 + posts.length, repository: { id: Number(protectedConfig("githubRepositoryId")), owner: { id: Number(protectedConfig("githubOwnerId")) } }, head_repository: { id: Number(protectedConfig("githubRepositoryId")) },
                    head_sha: source, head_branch: 'main', path: `.github/workflows/${active.stages[index].workflow}`, event: 'workflow_dispatch', run_attempt: 1,
                    display_title: coordinatedRunTitle(active, index), status: 'completed', conclusion: body.inputs.operation === 'qualify-all' ? 'failure' : 'success' });
                if (cleanup && loseCleanupResponse) {
                    loseCleanupResponse = false;
                    throw Error('lost response');
                }
                return;
            }
            if (path.startsWith('actions/runs/'))
                return runs.find(run => run.id === Number(path.split('/').at(-1)));
            return { workflow_runs: runs.filter(run => path.includes(run.path.split('/').at(-1))) };
        } };
    await advanceCoordinator(journal, deps);
    await advanceCoordinator(journal, deps);
    const uncertain = await advanceCoordinator(journal, deps);
    assert.equal(uncertain.state, 'dispatch-uncertain');
    assert.deepEqual(posts, ['release', 'qualify-all', 'cleanup-qualification']);
    await advanceCoordinator(journal, deps);
    const result = await advanceCoordinator(journal, deps);
    assert.equal(result.state, 'complete');
    assert.deepEqual(posts, ['release', 'qualify-all', 'cleanup-qualification', 'web']);
    assert.equal(result.runs[1], 103);
    assert.ok(saves.some(value => value.stages[1].recovery?.stages[0].status === 'dispatching'));
});
test('new Preview completes after deployment with health/browser checks and requests separate qualification', async () => {
    const f = fixture();
    let result;
    for (let i = 0; i < 3; i++)
        result = await advanceCoordinator(f.journal, f.deps);
    assert.equal(result.state, 'complete');
    assert.deepEqual(f.posts.map(post => post.inputs.operation ?? 'web'), ['release', 'web']);
    assert.match(result.next, /target qualification/);
    assert.equal(f.journal.policyVersion, 2);
});
test('unknown or inconsistent journal policies are refused before dispatch', async () => {
    const f = fixture();
    f.journal.policyVersion = 99;
    await assert.rejects(advanceCoordinator(f.journal, f.deps), /invalid journal/);
    assert.equal(f.posts.length, 0);
});
test('independent qualification discovers its dispatched run and retains the pinned live release on cleanup recovery', async () => {
    const { componentReleasePlan } = await import('./release-components.mjs');
    const changes = () => [];
    const base = { source, runId: 70, deploymentId: 7 };
    const selection = componentReleasePlan({ source, target: 'qualification', baselines: { native: base, web: { ...base, runId: 71, deploymentId: 8 } }, changes });
    const journal = createCoordinator({ source, id, target: 'qualification', mode: 'auto', selection });
    const runs = [], posts = [], saves = [];
    const history = id => ({ id, head_sha: source, head_branch: 'main', repository: { id: Number(protectedConfig("githubRepositoryId")), owner: { id: Number(protectedConfig("githubOwnerId")) } }, head_repository: { id: Number(protectedConfig("githubRepositoryId")) },
        run_attempt: 1, event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
        path: id === 70 ? '.github/workflows/native-development.yml' : '.github/workflows/deploy.yml',
        display_title: id === 70 ? 'Native development · release · api · -' : 'Storefront · development · preview=true · full=false' });
    const deps = { changes, save: async (value) => saves.push(structuredClone(value)), preflight: async () => ({ passed: true }),
        recoverReference: async (runId, releaseId) => {
            assert.equal(releaseId, 'native-70');
            return { key: "source/releases/native-" + protectedConfig("resource_8d0190ecec7d") + "/qualification-complete-summary-" + (releaseId) + "-run-" + (runId) + ".json", version: 'version', sha256: 'b'.repeat(64) };
        }, api: async (path, body) => {
            if (path === 'branches/main')
                return { commit: { sha: source } };
            if (path.startsWith('deployments?'))
                return [{ id: 7, environment: 'Preview', sha: source }, { id: 8, environment: 'Preview', sha: source }];
            if (path.includes('/statuses?'))
                return [{ state: 'success', log_url: `https://github.com/bentbrain/bent-mono/actions/runs/${path.split('/')[1] === '7' ? 70 : 71}` }];
            if (body) {
                const cleanup = body.inputs.operation === 'cleanup-qualification';
                assert.equal(body.inputs.verify_release, 'native-70');
                const savedStage = cleanup ? saves.at(-1).stages[0].recovery.stages[0] : saves.at(-1).stages[0];
                assert.equal(savedStage.status, 'dispatching');
                posts.push(body);
                const active = cleanup ? journal.stages[0].recovery : journal;
                runs.push({ ...history(100 + posts.length), path: '.github/workflows/native-development.yml',
                    display_title: coordinatedRunTitle(active, 0), conclusion: cleanup ? 'success' : 'failure' });
                return;
            }
            if (path.startsWith('actions/runs/')) {
                const runId = Number(path.split('/').at(-1));
                return runId < 100 ? history(runId) : runs.find(run => run.id === runId);
            }
            return { workflow_runs: runs };
        } };
    await advanceCoordinator(journal, deps);
    await advanceCoordinator(journal, deps);
    const result = await advanceCoordinator(journal, deps);
    assert.equal(result.state, 'complete');
    assert.deepEqual(posts.map(post => post.inputs.operation), ['qualify-all', 'cleanup-qualification']);
    assert.deepEqual(result.runs, [102]);
});
