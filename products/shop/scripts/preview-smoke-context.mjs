import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { componentBaselines, releaseComponents } from './release-components.mjs';
import { gitChanges } from './deployment-plan.mjs';
import { githubApi } from './github-actions.mjs';
import { verifyDispatchSource } from './release-dispatch-guard.mjs';
export function verifySmokeBaselines(source, baselines, changes = gitChanges) {
    if (!/^[a-f0-9]{40}$/.test(source ?? '') || baselines.native?.source !== source ||
        !baselines.web?.source || releaseComponents(changes(baselines.web.source, source)).web)
        throw Error('Camera smoke requires the exact released native source and a verified unchanged deployed storefront.');
    return { schemaVersion: 1, source, baselines };
}
if (import.meta.main) {
    const env = process.env, phase = process.argv[2];
    verifyDispatchSource(env);
    if (env.GITHUB_REPOSITORY !== 'bentbrain/bent-mono' || env.GITHUB_REPOSITORY_ID !== protectedConfig("githubRepositoryId") ||
        env.GITHUB_REPOSITORY_OWNER_ID !== protectedConfig("githubOwnerId") || env.GITHUB_REF !== 'refs/heads/main' ||
        env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_RUN_ATTEMPT !== '1' ||
        env.GITHUB_WORKFLOW_REF !== 'bentbrain/bent-mono/.github/workflows/preview-smoke.yml@refs/heads/main' ||
        !env.RELEASE_EXPECTED_SOURCE || !env.RUNNER_TEMP?.startsWith('/') || !['before', 'after'].includes(phase))
        throw Error('Preview smoke requires its first-attempt main workflow.');
    const api = githubApi({ token: env.GH_TOKEN, repository: env.GITHUB_REPOSITORY });
    const record = verifySmokeBaselines(env.GITHUB_SHA, await componentBaselines({ api, target: 'preview' }));
    const before = join(env.RUNNER_TEMP, 'preview-smoke-before.json');
    if (phase === 'after' && !isDeepStrictEqual(record, JSON.parse(resolveProtectedTemplate(await readFile(before, 'utf8')))))
        throw Error('Preview sources changed during the camera smoke.');
    await writeFile(join(env.RUNNER_TEMP, `preview-smoke-${phase}.json`), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
}
