import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import { parsePromotionInput } from "./release-promotion-input.mjs";
import { cleanupCoordinatorPlan, downloadQualificationReference, downloadRendererReference, discoverRendererBaseline } from "./release-qualification-recovery.mjs";
import { componentBaselines, componentReleasePlan, verifyComponentBaselines } from "./release-components.mjs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs, isDeepStrictEqual as equal } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { runPreflight } from "./release-preflight.mjs";
import { coordinatorTimings } from "./release-timings.mjs";
import { collectActionsUsage, reviewReleaseBudget } from "./actions-usage.mjs";
const repository = "bentbrain/bent-mono";
const check = (value, reason) => {
    if (!value)
        throw Error(`Release coordinator stopped: ${reason}`);
};
const git = args => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
export function coordinatorPlan(target, mode = "full", policyVersion = 3) {
    check(["full", "api"].includes(mode) && [1, 2, 3].includes(policyVersion), "choose full or api mode and a supported release policy.");
    if (target === "preview")
        return [
            { workflow: "native-development.yml", inputs: { operation: "release", release_mode: mode } },
            ...(policyVersion === 1 ? [{ workflow: "native-development.yml", inputs: { operation: "qualify-all" } }] : []),
            { workflow: "deploy.yml", inputs: { environment: "development", web_only_preview: true } },
        ];
    if (target === "production")
        return [
            { workflow: "native-production.yml", inputs: { operation: "promote", release_mode: mode } },
            { workflow: "web-production.yml", inputs: {} },
        ];
    throw Error("Choose preview or production. Production requires separately reviewed qualification and owner acceptance receipts.");
}
export function createCoordinator({ source, target, mode = "full", selection, promotion, policyVersion = selection?.schemaVersion ?? 3, id = randomUUID() }) {
    check(/^[a-f0-9]{40}$/.test(source) && /^[a-f0-9-]{36}$/.test(id), "exact source and journal identity required.");
    check(mode !== "auto" || (selection?.source === source && selection?.target === target), "auto mode requires a source-bound component plan.");
    check([1, 2, 3].includes(policyVersion), "unknown release policy version.");
    check(target !== "qualification" || mode === "auto", "qualification requires a source-bound auto plan.");
    if (promotion) {
        check(target === "production", "promotion input requires a Production journal.");
        parsePromotionInput(JSON.stringify(promotion), source);
    }
    return { schemaVersion: 1, ...(policyVersion >= 2 ? { policyVersion } : {}), repository, id, source, target, mode, ...(promotion ? { promotion } : {}), ...(mode === "auto" ? { selection } : {}), createdAt: new Date().toISOString(),
        stages: (mode === "auto" ? selection.stages : coordinatorPlan(target, mode, policyVersion)).map(stage => ({ ...stage, status: "pending" })) };
}
export function coordinatedRunTitle(journal, index) {
    const stage = journal.stages[index], inputs = stage.inputs;
    const suffix = `main · ${journal.source} · [release-${journal.id}-${index}]`;
    if (stage.workflow.startsWith("native-")) {
        const environment = stage.workflow === "native-development.yml" ? "development" : "production";
        const release = inputs.verify_release ?? (["qualify-all", "qualify-components"].includes(inputs.operation) ? `native-${journal.stages[0].runId}` : "-");
        return `Native ${environment} · ${inputs.operation} · ${inputs.release_mode ?? "full"} · ${release} · - · ${suffix}`;
    }
    if (stage.workflow === "preview-smoke.yml")
        return `Preview smoke · ${suffix}`;
    return stage.workflow === "deploy.yml" ? `Storefront · development · preview=true · full=false · ${suffix}` : `Storefront Production · ${suffix}`;
}
export function verifyCoordinatedRun(run, journal, index) {
    check(run && run.head_sha === journal.source && run.head_branch === "main" && run.path === `.github/workflows/${journal.stages[index].workflow}` &&
        run.event === "workflow_dispatch" && run.run_attempt === 1 && run.repository?.id === Number(protectedConfig("githubRepositoryId")) &&
        run.repository?.owner?.id === Number(protectedConfig("githubOwnerId")) && run.head_repository?.id === Number(protectedConfig("githubRepositoryId")) &&
        run.display_title === coordinatedRunTitle(journal, index), "run source, workflow, identity, attempt or correlation differs from the journal.");
    return run;
}
// One durable state transition per call. The CLI owns polling and the file lock.
// A dispatch intent is saved BEFORE POST. Resume can only discover that run,
// never repeat a POST whose acknowledgement was lost.
export async function advanceCoordinator(journal, { api, save, preflight, changes, recoverReference }) {
    check(journal.schemaVersion === 1 && journal.repository === repository && /^[a-f0-9]{40}$/.test(journal.source) &&
        /^[a-f0-9-]{36}$/.test(journal.id) && [1, 2, 3].includes(journal.policyVersion ?? 1), "invalid journal.");
    if (journal.mode === "auto")
        check(journal.selection?.schemaVersion === (journal.policyVersion ?? 1), "journal and selection policies differ.");
    if (journal.promotion) {
        check(journal.target === "production", "promotion input target.");
        parsePromotionInput(JSON.stringify(journal.promotion), journal.source);
    }
    const plan = journal.mode === "cleanup" ? cleanupCoordinatorPlan(journal) : journal.mode === "auto" ? journal.selection?.stages : coordinatorPlan(journal.target, journal.mode, journal.policyVersion ?? 1);
    check(Array.isArray(plan) && equal(journal.stages.map(({ workflow, inputs }) => ({ workflow, inputs })), plan), "journal plan was changed.");
    if (journal.mode === "auto")
        check(equal(componentReleasePlan({ source: journal.source, target: journal.target,
            baselines: journal.selection?.baselines, rendererBaseline: journal.selection?.rendererBaseline, policyVersion: journal.selection?.schemaVersion, changes }), journal.selection), "component selection was changed.");
    const verifyBaselines = async () => {
        if (journal.mode === "auto")
            verifyComponentBaselines(journal, await componentBaselines({ api, target: journal.target === "qualification" ? "preview" : journal.target }));
    };
    for (const [index, stage] of journal.stages.entries()) {
        check(["pending", "dispatching", "dispatched", "uncertain", "complete"].includes(stage.status), "unknown stage state.");
        if (stage.status === "pending") {
            check(!stage.runId, "pending stage contains a run.");
            await verifyBaselines();
            const prerequisites = await preflight(stage, journal, index);
            if (!prerequisites.passed)
                return { state: "blocked", index, checks: prerequisites.checks };
            // Recheck source immediately before the intent. The workflow independently
            // compares expected_source to its resolved checkout, closing the dispatch race.
            const branch = await api("branches/main");
            check(branch.commit?.sha === journal.source, "main advanced before dispatch.");
            stage.dispatchInputs = { ...stage.inputs,
                ...(stage.inputs.operation === "promote" && journal.promotion ? { promotion_input: JSON.stringify(journal.promotion) } : {}),
                ...(["qualify-all", "qualify-components"].includes(stage.inputs.operation) ? { verify_release: stage.inputs.verify_release ?? `native-${journal.stages[0].runId}` } : {}),
                expected_source: journal.source, coordination_id: `release-${journal.id}-${index}` };
            stage.status = "dispatching";
            stage.dispatchedAt = new Date().toISOString();
            await save(journal);
            try {
                await api(`actions/workflows/${stage.workflow}/dispatches`, { ref: "main", inputs: stage.dispatchInputs });
            }
            catch {
                stage.status = "uncertain";
                await save(journal);
                return { state: "dispatch-uncertain", index, message: "Inspect or resume this journal to discover the run. Do not dispatch again." };
            }
            stage.status = "dispatched";
            await save(journal);
            return { state: "waiting", index };
        }
        if (!stage.runId) {
            const matches = [];
            for (let page = 1; page <= 10; page++) {
                const result = await api(`actions/workflows/${stage.workflow}/runs?head_sha=${journal.source}&event=workflow_dispatch&per_page=100&page=${page}`);
                check(Array.isArray(result.workflow_runs), "run discovery failed.");
                matches.push(...result.workflow_runs.filter(run => run.display_title?.endsWith(`[release-${journal.id}-${index}]`)));
                if (result.workflow_runs.length < 100)
                    break;
                check(page < 10, "run discovery exceeded its bounded inventory.");
            }
            check(matches.length <= 1, "multiple runs share this journal correlation; inspect them.");
            if (!matches.length)
                return { state: stage.status === "dispatched" ? "waiting" : "dispatch-uncertain", index };
            stage.runId = verifyCoordinatedRun(matches[0], journal, index).id;
            check(Number.isSafeInteger(stage.runId) && stage.runId > 0, "invalid run ID.");
            await save(journal);
        }
        const run = verifyCoordinatedRun(await api(`actions/runs/${stage.runId}`), journal, index);
        check(run.id === stage.runId, "different run returned.");
        if (run.status !== "completed")
            return { state: "waiting", index, runId: run.id, status: run.status };
        let completedRun = run;
        if (run.conclusion !== "success") {
            if (run.conclusion === "failure" && ["qualify-all", "qualify-components"].includes(stage.inputs.operation) && recoverReference) {
                const releaseId = stage.inputs.verify_release ?? `native-${journal.stages[0].runId}`;
                if (!stage.recovery) {
                    const reference = await recoverReference(run.id, releaseId);
                    if (reference) {
                        const recovery = { schemaVersion: 1, repository, id: randomUUID(), source: journal.source, target: "preview", mode: "cleanup",
                            createdAt: new Date().toISOString(), functionalRunId: run.id, functionalReference: reference, releaseId };
                        recovery.stages = cleanupCoordinatorPlan(recovery).map(item => ({ ...item, status: "pending" }));
                        stage.recovery = recovery;
                        await save(journal);
                    }
                }
                if (stage.recovery) {
                    check(stage.recovery.functionalRunId === run.id && stage.recovery.source === journal.source &&
                        stage.recovery.releaseId === releaseId && stage.recovery.mode === "cleanup", "recovery journal was changed.");
                    const recovery = await advanceCoordinator(stage.recovery, { api, save: () => save(journal), preflight, changes });
                    if (recovery.state !== "complete")
                        return { ...recovery, originalQualificationRunId: run.id };
                    completedRun = await api(`actions/runs/${stage.recovery.stages[0].runId}`);
                }
            }
            if (completedRun === run)
                return { state: "failed", index, runId: run.id, conclusion: run.conclusion,
                    message: "Inspect failed steps and saved evidence. No recoverable completion was found; never rerun an uncertain native mutation." };
        }
        if (stage.status !== "complete") {
            stage.status = "complete";
            stage.startedAt = run.run_started_at;
            stage.completedAt = completedRun.updated_at;
            await save(journal);
        }
    }
    await verifyBaselines();
    if (journal.mode === "auto")
        check((await api("branches/main")).commit?.sha === journal.source, "main advanced before component-plan completion.");
    return { state: "complete", target: journal.target, runs: journal.stages.map(stage => stage.recovery?.stages[0].runId ?? stage.runId), timings: coordinatorTimings(journal),
        next: journal.stages.length === 0 ? journal.selection?.next ?? "No application component changed; no release was dispatched." :
            journal.target === "qualification" ? "Review the immutable qualification and the source-bound automated browser evidence before Production promotion." :
                journal.target === "preview" && journal.policyVersion >= 2 ? "Preview health and camera checks passed. Run release:coordinate --target qualification separately before native Production promotion, then review artifacts and use the existing source-bound browser evidence for automated acceptance." :
                    journal.target === "preview" ? "Review the selected release artifacts and obtain owner phone acceptance. Record the reviewed immutable receipt references and actual owner report in a promotion input file, then start a separate production journal." : "Review the saved evidence for the selected components." };
}
let githubToken;
async function githubRequest(path, body) {
    const token = githubToken ??= process.env.GH_TOKEN || execFileSync("gh", ["auth", "token", "--user", "bentbrain"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
        method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28" }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    check(response.ok, "GitHub response not confirmed; private response content was not logged.");
    return response.status === 204 ? undefined : response.json();
}
async function acquireLock(path) {
    try {
        const lock = await open(`${path}.lock`, "wx", 0o600);
        await lock.writeFile(JSON.stringify({ pid: process.pid }));
        await lock.close();
    }
    catch (error) {
        if (error.code !== "EEXIST")
            throw error;
        throw Error(`Journal lock exists at ${path}.lock. Check its process before removing a stale lock; never start a competing coordinator.`);
    }
    return () => unlink(`${path}.lock`);
}
if (import.meta.main) {
    try {
        const { values } = parseArgs({ options: { source: { type: "string" }, target: { type: "string" }, mode: { type: "string" },
                journal: { type: "string" }, "promotion-file": { type: "string" }, "budget-reason": { type: "string" }, execute: { type: "boolean" }, resume: { type: "boolean" }, once: { type: "boolean" } } });
        check(!values.resume || values.journal, "resume requires --journal.");
        const source = values.source ?? git(["rev-parse", "HEAD"]), target = values.target ?? "preview", mode = values.mode ?? "auto";
        check(!values.resume || !values["promotion-file"], "resume uses the promotion input already pinned in its journal.");
        const promotion = values["promotion-file"] ? parsePromotionInput(await readFile(resolve(values["promotion-file"]), "utf8"), source) : undefined;
        const rendererBaseline = !values.resume && mode === "auto" && ["preview", "qualification"].includes(target)
            ? await discoverRendererBaseline(githubRequest, id => downloadRendererReference(githubRequest, id, githubToken)) : null;
        const selection = !values.resume && mode === "auto" ? componentReleasePlan({ source, target, rendererBaseline, baselines: await componentBaselines({ api: githubRequest, target: target === "qualification" ? "preview" : target }) }) : undefined;
        const journal = values.resume ? JSON.parse(resolveProtectedTemplate(await readFile(resolve(values.journal), "utf8"))) : createCoordinator({
            source, target, mode, selection, promotion
        });
        check(!values.resume || ((!values.source || values.source === journal.source) && (!values.target || values.target === journal.target) &&
            (!values.mode || values.mode === journal.mode)), "resume cannot change the pinned plan or source.");
        if (journal.mode === "auto")
            check(equal(componentReleasePlan({ source: journal.source, target: journal.target, baselines: journal.selection?.baselines, rendererBaseline: journal.selection?.rendererBaseline, policyVersion: journal.selection?.schemaVersion }), journal.selection), "component plan differs from the pinned source comparison.");
        // Budget admission happens once for a new batch, before any durable intent.
        // Resume never interrupts a partially mutated pair or its cleanup/recovery.
        if (!values.resume) {
            journal.costReview = reviewReleaseBudget(await collectActionsUsage(githubRequest), journal.stages, values["budget-reason"]);
            if (values.execute) {
                console.log(JSON.stringify({ costReview: journal.costReview }));
                check(journal.costReview.allowed, journal.costReview.guidance);
            }
        }
        if (!values.execute) {
            console.log(JSON.stringify(journal, null, 2));
        }
        else {
            check(git(["rev-parse", "HEAD"]) === journal.source && git(["status", "--porcelain"]) === "", "use a clean checkout of the pinned source.");
            const path = resolve(values.journal ?? `.data/release-coordinator/${journal.id}.json`);
            await mkdir(dirname(path), { recursive: true, mode: 0o700 });
            const unlock = await acquireLock(path);
            try {
                if (!values.resume) {
                    const file = await open(path, "wx", 0o600);
                    await file.writeFile(JSON.stringify(journal, null, 2));
                    await file.close();
                }
                const save = async (value) => {
                    const temporary = `${path}.${randomUUID()}.tmp`, file = await open(temporary, "wx", 0o600);
                    await file.writeFile(JSON.stringify(value, null, 2));
                    await file.sync();
                    await file.close();
                    await rename(temporary, path);
                    const directory = await open(dirname(path), "r");
                    await directory.sync();
                    await directory.close();
                };
                console.log(`Release journal: ${path}`);
                let last, ticks = 0, stopping = false;
                const stop = () => { stopping = true; };
                process.once("SIGINT", stop);
                process.once("SIGTERM", stop);
                do {
                    const result = await advanceCoordinator(journal, { api: githubRequest, save,
                        recoverReference: (runId, releaseId) => downloadQualificationReference(githubRequest, runId, releaseId, githubToken), preflight: (stage, journal, index) => {
                            check(git(["rev-parse", "HEAD"]) === journal.source && git(["status", "--porcelain"]) === "", "checkout changed during coordination.");
                            return runPreflight({ environment: journal.target === "production" ? "production" : "development",
                                lane: stage.workflow.startsWith("native-") ? "native" : "web", operation: stage.inputs.operation,
                                "promotion-input": journal.promotion ? JSON.stringify(journal.promotion) : undefined,
                                "release-mode": stage.inputs.release_mode ?? "full", "renderer-reference": stage.inputs.renderer_reference, ref: "refs/heads/main", github: true,
                                ...(["qualify-all", "qualify-components"].includes(stage.inputs.operation) ? { "verify-release": stage.inputs.verify_release ?? `native-${journal.stages[index - 1].runId}` } : {}),
                                ...(stage.inputs.operation === "cleanup-qualification" ? { "verify-release": stage.inputs.verify_release,
                                    "qualification-reference": stage.inputs.qualification_reference } : {}) });
                        } });
                    const text = JSON.stringify(result);
                    if (text !== last) {
                        console.log(text);
                        last = text;
                    }
                    if (result.state !== "waiting") {
                        if (result.state !== "complete")
                            process.exitCode = 1;
                        break;
                    }
                    if (values.once || stopping)
                        break;
                    check(++ticks < 240, "one-hour observation limit reached; resume this journal without redispatching.");
                    await delay(15000);
                } while (true);
            }
            finally {
                await unlock();
            }
        }
    }
    catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
