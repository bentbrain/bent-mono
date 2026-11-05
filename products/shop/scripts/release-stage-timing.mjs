import { protectedConfig } from "./protected-config.mjs";
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
async function record(event) {
    const env = process.env;
    if (!env.NATIVE_OPERATION || env.GITHUB_RUN_ATTEMPT !== '1' || env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY_ID !== protectedConfig("githubRepositoryId") || env.GITHUB_REPOSITORY_OWNER_ID !== protectedConfig("githubOwnerId") || !env.RUNNER_TEMP?.startsWith('/'))
        return;
    try {
        await appendFile(join(env.RUNNER_TEMP, 'release-timings.ndjson'), JSON.stringify({ schemaVersion: 1, runId: env.GITHUB_RUN_ID, source: env.GITHUB_SHA, ...event }) + '\n', { mode: 0o600 });
    }
    catch {
        console.warn('Release timing output unavailable. Admission and recovery checks are unchanged.');
    }
}
export async function measureReleaseStage(stage, operation, { write = record, now = Date.now, id = randomUUID() } = {}) {
    if (!/^[a-z][a-z0-9-]+$/.test(stage))
        throw Error('Fixed release timing label required.');
    const start = now();
    await write({ id, stage, event: 'started', at: new Date(start).toISOString() });
    let conclusion = 'failure';
    try {
        const result = await operation();
        conclusion = 'success';
        return result;
    }
    finally {
        const end = now();
        await write({ id, stage, event: 'completed', at: new Date(end).toISOString(), durationMs: Math.max(0, end - start), conclusion });
    }
}
