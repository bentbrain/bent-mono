import { protectedConfig } from "./protected-config.mjs";
import { validationEnvironment } from "./validation-environment.mjs";
import { releaseTree } from "./monorepo-source.mjs";
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const hash = value => createHash('sha256').update(value).digest('hex');
const metadata = path => path.startsWith('docs/') || path === 'README.md' ||
    ['infra/story-video-lambda/development-qualification.json', 'infra/story-video-lambda/production-promotion.json'].includes(path);
const tree = releaseTree;
export function validationInputs(source, { env = process.env, readTree = tree, node = process.version, platform = process.platform, arch = process.arch } = {}) {
    if (!/^[a-f0-9]{40}$/.test(source ?? '') || !/^v24\./.test(node) || platform !== 'linux' || arch !== 'x64' ||
        env.ImageOS !== 'ubuntu24' || !/^[0-9.]+$/.test(env.ImageVersion ?? ''))
        return null;
    const components = { web: [], api: [], renderer: [], policy: [] };
    for (const record of readTree(source).split('\0').filter(Boolean)) {
        const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(record);
        if (!match)
            return null;
        const [, mode, oid, path] = match;
        if (metadata(path))
            continue;
        const component = path.startsWith('apps/web/') ? 'web' : path.startsWith('workers/api/') ? 'api' :
            path.startsWith('workers/video-renderer/') ? 'renderer' : 'policy';
        components[component].push({ mode, oid, path });
    }
    const runtime = validationRuntime({ env, node, platform, arch });
    if (!runtime)
        return null;
    const input = { schemaVersion: 1, scope: 'repository-components-v2', ...runtime, components: Object.fromEntries(Object.entries(components).map(([name, files]) => [name, hash(JSON.stringify(files))])) };
    return { ...input, sourceCommit: source, inputsDigest: hash(JSON.stringify(input)) };
}
export function validationRuntime({ env = process.env, node = process.version, platform = process.platform, arch = process.arch } = {}) {
    if (!/^v24\./.test(node) || platform !== 'linux' || arch !== 'x64' || env.ImageOS !== 'ubuntu24' || !/^[0-9.]+$/.test(env.ImageVersion ?? ''))
        return null;
    // The check wrapper pins storefront credentials to fixtures. Include remaining
    // application/build overrides, without publishing their values in the receipt.
    const overrides = Object.entries(validationEnvironment(env)).filter(([key]) => /^(?:NODE_|NEXT_|PUBLIC_|PRIVATE_|FOREVER_|STORY_|SHOPIFY_|PRINTIFY_|OPENAI_|TURNSTILE_|VERCEL_|CLOUDFLARE_|AWS_|PLAYWRIGHT_|E2E_|POSTHOG_|LAN_DEV_ORIGIN$|SHOP_ID$|CI$)/.test(key))
        .filter(([key]) => !['NODE_OPTIONS'].includes(key)).sort(([a], [b]) => a.localeCompare(b));
    if (env.NODE_OPTIONS || env.E2E_LOCAL_PRODUCTION === '1')
        return null;
    return { toolchain: { node, platform, arch, imageOS: env.ImageOS, imageVersion: env.ImageVersion }, environmentDigest: hash(JSON.stringify(overrides)) };
}
export function matchingValidation(record, current) {
    return record?.schemaVersion === 1 && current?.schemaVersion === 1 && record.scope === current.scope &&
        /^[a-f0-9]{64}$/.test(record.inputsDigest ?? '') && record.inputsDigest === current.inputsDigest;
}
if (import.meta.main) {
    const env = process.env;
    if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_REPOSITORY_ID !== protectedConfig("githubRepositoryId") ||
        env.GITHUB_REPOSITORY_OWNER_ID !== protectedConfig("githubOwnerId") || env.GITHUB_RUN_ATTEMPT !== '1' || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') ||
        !/^[a-z_-]+$/.test(env.GITHUB_JOB ?? '') || !env.RUNNER_TEMP?.startsWith('/'))
        throw Error('Validation receipt requires first-attempt personal main Actions.');
    const inputs = validationInputs(env.GITHUB_SHA);
    if (inputs)
        await writeFile(join(env.RUNNER_TEMP, `validation-inputs-${env.GITHUB_JOB}.json`), JSON.stringify({ ...inputs, runId: Number(env.GITHUB_RUN_ID), job: env.GITHUB_JOB }), { flag: 'wx', mode: 0o600 });
}
