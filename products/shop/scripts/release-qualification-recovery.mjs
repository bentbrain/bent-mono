import { protectedConfig } from "./protected-config.mjs";
import { execFileSync } from 'node:child_process';
import { mkdtemp, lstat, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoveryReference, rendererReference } from './native-qualification-reference.mjs';
export function cleanupCoordinatorPlan(journal) {
    const { reference, runId } = recoveryReference(JSON.stringify(journal.functionalReference), journal.releaseId);
    if (journal.target !== 'preview' || runId !== journal.functionalRunId)
        throw Error('Cleanup journal differs from its original qualification.');
    return [{ workflow: 'native-development.yml', inputs: { operation: 'cleanup-qualification', verify_release: journal.releaseId,
                qualification_reference: JSON.stringify(reference) } }];
}
async function downloadPointer(api, runId, token, filename, parse) {
    const name = `qualification-reference-${runId}`;
    const listing = await api(`actions/runs/${runId}/artifacts?per_page=100`);
    if (!Array.isArray(listing.artifacts) || listing.total_count > 100)
        throw Error('Qualification artifact inventory is incomplete.');
    const matches = listing.artifacts.filter(artifact => artifact.name === name && artifact.expired === false);
    if (matches.length === 0)
        return null;
    if (matches.length !== 1)
        throw Error('Ambiguous qualification reference artifact.');
    const directory = await mkdtemp(join(tmpdir(), 'qualification-reference-'));
    try {
        execFileSync('gh', ['run', 'download', String(runId), '--repo', 'bentbrain/bent-mono', '--name', name, '--dir', directory], { env: { ...process.env, GH_TOKEN: token }, stdio: ['ignore', 'ignore', 'pipe'], timeout: 30000 });
        const path = join(directory, filename);
        let stat;
        try {
            stat = await lstat(path);
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return null;
            throw error;
        }
        if (!stat.isFile() || stat.size > 4096)
            throw Error('Invalid qualification pointer file.');
        return parse(await readFile(path, 'utf8'));
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
}
export async function downloadQualificationReference(api, runId, releaseId, token) {
    return downloadPointer(api, runId, token, 'qualification-reference.json', value => {
        const parsed = recoveryReference(value, releaseId);
        if (parsed.runId !== runId)
            throw Error('Artifact points at a different functional run.');
        return parsed.reference;
    });
}
export async function downloadRendererReference(api, runId, token) {
    return downloadPointer(api, runId, token, 'renderer-reference.json', value => {
        const record = JSON.parse(value), parsed = rendererReference(JSON.stringify(record.reference));
        if (record.schemaVersion !== 1 || parsed.runId !== runId || parsed.releaseId !== record.expectedPair?.releaseId ||
            !/^[a-f0-9]{40}$/.test(record.sourceCommit ?? '') || !/^v24\./.test(record.nodeVersion ?? '') ||
            !/^[a-f0-9]{64}$/.test(record.inputsDigest ?? ''))
            throw Error('Invalid renderer pointer.');
        return record;
    });
}
export async function discoverRendererBaseline(api, download) {
    const result = await api('actions/workflows/native-development.yml/runs?branch=main&event=workflow_dispatch&status=success&per_page=30');
    if (!Array.isArray(result.workflow_runs))
        return null;
    for (const item of result.workflow_runs.filter(run => /^Native development · (?:qualify-all|qualify-components|cleanup-qualification) · full · /.test(run.display_title ?? '')).slice(0, 10)) {
        const run = await api(`actions/runs/${item.id}`);
        if (run.id !== item.id || run.status !== 'completed' || run.conclusion !== 'success' || run.run_attempt !== 1 ||
            run.event !== 'workflow_dispatch' || run.head_branch !== 'main' || run.repository?.id !== Number(protectedConfig("githubRepositoryId")) ||
            run.repository?.owner?.id !== Number(protectedConfig("githubOwnerId")) || run.head_repository?.id !== Number(protectedConfig("githubRepositoryId")) || run.path !== '.github/workflows/native-development.yml')
            continue;
        const pointer = await download(run.id);
        if (pointer && pointer.sourceCommit === run.head_sha)
            return pointer;
    }
    return null;
}
