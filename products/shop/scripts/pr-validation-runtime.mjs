import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validationRuntime } from './validation-inputs.mjs';
const sha = value => /^[a-f0-9]{40}$/.test(value ?? '');
export function protectedRuntimeRecord(event, env, checkout, runtime = validationRuntime({ env })) {
    const pull = event.pull_request;
    const job = env.GITHUB_JOB === 'check' ? 'check' : env.GITHUB_JOB === 'repository' ? 'repository' :
        env.GITHUB_JOB === 'browser' && ['1', '2'].includes(env.PR_VALIDATION_SHARD) ? `browser (${env.PR_VALIDATION_SHARD})` : null;
    if (!job || !pull?.labels?.some(label => label.name === 'ci:release-candidate') || !runtime || env.GITHUB_EVENT_NAME !== 'pull_request' || env.GITHUB_RUN_ATTEMPT !== '1' ||
        env.GITHUB_REPOSITORY_ID !== protectedConfig("githubRepositoryId") || env.GITHUB_REPOSITORY_OWNER_ID !== protectedConfig("githubOwnerId") ||
        !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') || !Number.isSafeInteger(pull?.number) || pull.number < 1 ||
        pull.base?.repo?.id !== Number(protectedConfig("githubRepositoryId")) || pull.base.repo.owner?.id !== Number(protectedConfig("githubOwnerId")) || pull.head?.repo?.id !== Number(protectedConfig("githubRepositoryId")) ||
        pull.base.ref !== 'main' || checkout !== pull.base.sha || !sha(checkout) || !sha(pull.head.sha) || !sha(env.GITHUB_SHA) ||
        env.GITHUB_REF !== `refs/pull/${pull.number}/merge`)
        return null;
    return { schemaVersion: job === 'check' ? 1 : 2, scope: job === 'check' ? 'protected-pr-runtime-v1' : 'protected-pr-runtime-v2',
        ...(job === 'check' ? {} : { validationJob: job }), cachePolicy: 'fresh-without-restored-caches-v1', runId: Number(env.GITHUB_RUN_ID), attempt: 1,
        pullNumber: pull.number, baseSha: checkout, headSha: pull.head.sha, mergeSha: env.GITHUB_SHA, ...runtime };
}
if (import.meta.main) {
    const env = process.env;
    const event = JSON.parse(resolveProtectedTemplate(await readFile(env.GITHUB_EVENT_PATH, 'utf8')));
    const checkout = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const record = protectedRuntimeRecord(event, env, checkout);
    if (record) {
        if (!env.RUNNER_TEMP?.startsWith('/'))
            throw Error('Missing runner temporary directory.');
        const suffix = record.validationJob === 'repository' ? '-repository' : record.validationJob ? `-browser-${env.PR_VALIDATION_SHARD}` : '';
        await writeFile(join(env.RUNNER_TEMP, `pr-validation-runtime${suffix}.json`), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    }
}
