import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configurationHash, protectedJson, releaseVercel, validateRuntime } from "./release-vercel.mjs";

const sha = "a".repeat(40);
const app = { name: "stay", directory: "apps/stay", project: "synthetic-guide", platform: "vercel" };
const config = { projectId: "prj_fixture", teamId: "team_fixture", expectedProductionId: "dpl_original", requiredCheckId: "chk_quality" };
function fixture(change = () => {}) {
  const project = { id: config.projectId, accountId: config.teamId, name: app.project, rootDirectory: app.directory,
    nodeVersion: "24.x", sourceFilesOutsideRootDirectory: true, autoAssignCustomDomains: false,
    link: { type: "github", org: "bentbrain", repo: "bent-mono", productionBranch: "main", repoId: 123 },
    targets: { production: { id: config.expectedProductionId } } };
  const deployment = { id: "dpl_candidate", project: { id: config.projectId }, team: { id: config.teamId }, name: app.project,
    target: "production", readyState: "READY", nodeVersion: "24.x", createdAt: 10,
    gitSource: { type: "github", sha, ref: "main", repoId: 123 },
    meta: { githubCommitOrg: "bentbrain", githubCommitRepo: "bent-mono", githubCommitSha: sha } };
  const definition = { id: config.requiredCheckId, name: "Release qualification", source: { kind: "git-provider", provider: "github", externalCheckName: "Release qualification" },
    blocks: "deployment-alias", targets: ["production"], projectId: config.projectId, ownerId: config.teamId };
  const state = { project, deployment, definitions: [definition], runs: [], inventory: [{ uid: deployment.id, created: 10, state: "READY" }], posts: [], qualifications: 0 };
  const quality = { sha, qualityRunId: 12, qualityAttempt: 1, pullRequest: 3 };
  const receipt = { at: new Date().toISOString(), app: "stay", deploymentId: deployment.id, sourceRevision: sha,
    runtimeQualified: true, configurationSha256: configurationHash(project, [definition]),
    checks: { hostPrivateGuide: true, hostPhotos: true, hostDraftEditorLoads: true, guestGuidePhotos: true, guestEditorDenied: true } };
  change(state, receipt);
  const vercel = async (path, method = "GET", body) => {
    if (method === "POST") { state.posts.push({ path, body }); if (state.uncertain) throw new Error("timeout"); return { accepted: true }; }
    if (path.startsWith("/v9/")) return structuredClone(state.project);
    if (path.startsWith("/v13/")) return structuredClone(state.deployment);
    if (path.includes("check-runs")) return { runs: structuredClone(state.runs) };
    if (path.includes("/checks")) return { checks: structuredClone(state.definitions) };
    if (path.includes("/v6/")) {
      state.duringInventory?.(state);
      return { deployments: structuredClone(state.inventory), pagination: { next: null } };
    }
    throw new Error(`Unexpected API route ${path}`);
  };
  return { state, receipt, vercel, qualify: async () => {
    state.qualifications++;
    if (state.rejectQuality) throw new Error("Quality not passed");
    if (state.qualifications === 2) state.duringFinalQualification?.(state);
    if (state.mutateOnFinalQuality && state.qualifications === 2) state.runs.push(state.mutateOnFinalQuality);
    return { ...quality, qualityAttempt: state.changeAttempt && state.qualifications === 2 ? 2 : 1 };
  }, checkout: async () => { if (state.dirty) throw new Error("dirty checkout"); } };
}
async function trial(action, change, verify) {
  const directory = await mkdtemp(join(tmpdir(), "bent-release-test-"));
  try {
    const f = fixture(change);
    const options = { action, app, config, deploymentId: "dpl_candidate", receipt: f.receipt, journalPath: join(directory, "intent.jsonl"), sha };
    await verify(f, options);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("manual staged promotion uses genuine source qualification without manufacturing a Vercel result", async () => {
  await trial("promote", () => {}, async (f, options) => {
    const result = await releaseVercel(options, f);
    assert.equal(result.status, "accepted-readback-required");
    assert.equal(result.nativeMirrorPresent, false);
    assert.equal(f.state.qualifications, 2);
    assert.deepEqual(f.state.posts, [{ path: "/v10/projects/prj_fixture/promote/dpl_candidate", body: {} }]);
    assert.match(await readFile(options.journalPath, "utf8"), /intent-recorded-no-retry/);
    await assert.rejects(releaseVercel(options, f), /EEXIST/);
    assert.equal(f.state.posts.length, 1);
  });
});
test("refreshes provider admission after final qualification before stage or promote", async () => {
  const drifts = [
    s => { s.project.targets.production.id = "dpl_otherRelease"; },
    s => { s.project.autoAssignCustomDomains = true; },
    s => { s.project.env = [{ key: "CHANGED_SETTING", value: "synthetic" }]; },
    s => { s.inventory.push({ uid: "dpl_newer", created: 11, state: "BUILDING" }); },
    s => { s.definitions[0].blocks = "none"; },
    s => { s.project.lastAliasRequest = { jobStatus: "pending" }; },
  ];
  for (const action of ["stage", "promote"]) {
    for (const drift of drifts) await trial(action, s => { s.duringFinalQualification = drift; }, async (f, options) => {
      await assert.rejects(releaseVercel(options, f));
      assert.equal(f.state.posts.length, 0);
      await assert.rejects(readFile(options.journalPath), { code: "ENOENT" });
    });
  }
});
test("promotion rechecks immutable deployment identity and readiness after qualification", async () => {
  for (const drift of [s => { s.deployment.gitSource.sha = "b".repeat(40); },
    s => { s.deployment.id = "dpl_other"; }, s => { s.deployment.readyState = "ERROR"; }]) {
    await trial("promote", s => { s.duringFinalQualification = drift; }, async (f, options) => {
      await assert.rejects(releaseVercel(options, f));
      assert.equal(f.state.posts.length, 0);
      await assert.rejects(readFile(options.journalPath), { code: "ENOENT" });
    });
  }
});
test("final project admission follows the potentially paginated inventory read", async () => {
  for (const action of ["stage", "promote"]) await trial(action, s => {
    s.duringInventory = state => { state.project.autoAssignCustomDomains = true; };
  }, async (f, options) => {
    await assert.rejects(releaseVercel(options, f));
    assert.equal(f.state.posts.length, 0);
    await assert.rejects(readFile(options.journalPath), { code: "ENOENT" });
  });
});
test("uncertain promotion retains its one-use intent and cannot be retried", async () => {
  await trial("promote", s => { s.uncertain = true; }, async (f, options) => {
    await assert.rejects(releaseVercel(options, f), /timeout/);
    assert.match(await readFile(options.journalPath, "utf8"), /intent-recorded-no-retry/);
    await assert.rejects(releaseVercel(options, f), /EEXIST/);
    assert.equal(f.state.posts.length, 1);
  });
});
test("stage sends Git source only and never uploads source files, environment overrides or aliases", async () => {
  await trial("stage", () => {}, async (f, options) => {
    await releaseVercel(options, f);
    assert.deepEqual(f.state.posts, [{ path: "/v13/deployments", body: { name: app.project, project: config.projectId,
      target: "production", gitSource: { type: "github", repoId: 123, ref: "main", sha } } }]);
  });
});
test("stage rejects changed workspace access, Node, native gate or automatic assignment", async () => {
  for (const mutate of [s => { s.project.nodeVersion = "22.x"; }, s => { s.project.sourceFilesOutsideRootDirectory = false; },
    s => { s.project.autoAssignCustomDomains = true; }, s => { s.definitions[0].blocks = "none"; }]) {
    await trial("stage", mutate, async (f, options) => {
      await assert.rejects(releaseVercel(options, f)); assert.equal(f.state.posts.length, 0);
    });
  }
});
test("inspect is read only and reports absent mirrors without treating them as native success", async () => {
  await trial("inspect", () => {}, async (f, options) => {
    const result = await releaseVercel(options, f);
    assert.equal(result.nativeMirrorPresent, false);
    assert.equal(result.quality.sha, sha);
    assert.equal(f.state.posts.length, 0);
  });
});
test("quality, ownership, source, runtime, concurrency and policy failures stop before mutation", async () => {
  const cases = [
    s => { s.rejectQuality = true; }, s => { s.dirty = true; },
    s => { s.project.accountId = "team_foreign"; }, s => { s.deployment.team.id = "team_foreign"; },
    s => { s.project.rootDirectory = "apps/elsewhere"; }, s => { s.project.link.repo = "old-repo"; },
    s => { s.project.link.productionBranch = "development"; }, s => { s.deployment.gitSource.sha = "b".repeat(40); },
    s => { s.deployment.meta.githubCommitRepo = "old-repo"; }, s => { s.deployment.target = "preview"; },
    s => { s.deployment.readyState = "ERROR"; }, s => { s.project.targets.production.id = "dpl_changed"; },
    s => { s.project.autoAssignCustomDomains = true; }, s => { s.changeAttempt = true; },
    s => { s.definitions[0].blocks = "none"; }, s => { s.definitions = []; },
    s => { s.inventory.push({ uid: "dpl_newer", created: 11, state: "READY" }); },
    s => { s.inventory.push({ uid: "dpl_older", created: 9, state: "BUILDING" }); },
    (_, r) => { r.checks.guestEditorDenied = false; }, (_, r) => { r.sourceRevision = "b".repeat(40); },
    (_, r) => { r.at = new Date(Date.now() + 60_000).toISOString(); },
    (_, r) => { r.at = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); },
    (_, r) => { r.configurationSha256 = "b".repeat(64); },
  ];
  for (const mutate of cases) await trial("promote", mutate, async (f, options) => {
    await assert.rejects(releaseVercel(options, f)); assert.equal(f.state.posts.length, 0);
  });
});
test("native queued, failed, duplicate, foreign and unknown blocking results cannot be overridden", async () => {
  const run = { checkId: config.requiredCheckId, deploymentId: "dpl_candidate", projectId: config.projectId,
    ownerId: config.teamId, status: "completed", conclusion: "succeeded" };
  for (const mutate of [
    s => { s.runs = [{ ...run, status: "queued" }]; }, s => { s.runs = [{ ...run, conclusion: "failed" }]; },
    s => { s.runs = [run, run]; }, s => { s.runs = [{ ...run, deploymentId: "dpl_foreign" }]; },
    s => { s.runs = [{ ...run, checkId: "chk_unknown" }]; },
    s => { s.definitions.push({ ...s.definitions[0], id: "chk_unknown" }); },
    s => { s.mutateOnFinalQuality = { ...run, status: "queued" }; },
  ]) await trial("promote", mutate, async (f, options) => {
    await assert.rejects(releaseVercel(options, f)); assert.equal(f.state.posts.length, 0);
  });
});
test("configuration changes invalidate runtime qualification; object key order does not", () => {
  const f = fixture();
  assert.equal(configurationHash(f.state.project, f.state.definitions), configurationHash({ ...f.state.project }, f.state.definitions));
  f.state.project.env = [{ key: "PRIVATE_SETTING", value: "synthetic" }];
  assert.throws(() => validateRuntime(f.receipt, { app, deployment: f.state.deployment, sha,
    fingerprint: configurationHash(f.state.project, f.state.definitions) }));
});
test("release inputs reject symlinks and broadly readable files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bent-release-input-"));
  try {
    const path = join(directory, "input.json"); await writeFile(path, '{"synthetic":true}', { mode: 0o600 });
    assert.deepEqual(await protectedJson(path), { synthetic: true });
    await symlink(path, join(directory, "link.json")); await assert.rejects(protectedJson(join(directory, "link.json")));
    await chmod(path, 0o644); await assert.rejects(protectedJson(path), /private files/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
