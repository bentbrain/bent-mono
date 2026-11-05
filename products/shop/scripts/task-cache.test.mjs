import { resolveProtectedTemplate } from "./protected-config.mjs";
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { taskRuntimeArgs, taskRuntimeKey } from './task-runtime.mjs';
import { validationEnvironment } from './validation-environment.mjs';
import { cacheReport } from './cache-report.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
test('actual Turbo hashing isolates application env and covers source, dependencies, patches, runtime and env files', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'task-cache-'));
    const monorepo = fileURLToPath(new URL('../../..', import.meta.url));
    const product = 'products/shop/';
    const put = (file, bytes) => { mkdirSync(dirname(join(cwd, file)), {recursive:true}); writeFileSync(join(cwd,file),bytes); };
    try {
        for (const file of ['package.json','bun.lock','turbo.json']) put(file,readFileSync(join(monorepo,file)));
        for (const folder of ['apps/web','workers/api','workers/video-renderer','packages/contracts','packages/product-image-renderer']) {
            put(product+folder+'/package.json',readFileSync(join(root,folder,'package.json')));
        }
        cpSync(join(monorepo,'packages/design-tokens'),join(cwd,'packages/design-tokens'),{recursive:true,filter: source => !source.includes('/node_modules')});
        put(product+'eslint.config.mjs',readFileSync(join(root,'eslint.config.mjs')));
        const patches = JSON.parse(readFileSync(join(monorepo,'package.json'),'utf8')).patchedDependencies ?? {};
        for (const file of Object.values(patches)) put(file,readFileSync(join(monorepo,file)));
        for (const file of ['apps/web/src/page.tsx','workers/api/src/index.ts','workers/video-renderer/src/renderer.mjs',
            'packages/contracts/src/design.ts','packages/contracts/src/product-mockup-geometry.js','apps/web/public/mockups/a.png',
            'workers/print-executor/src/index.ts','assets/lifestyle/featured-blank-white.png',
            'scripts/release-coordinator.mjs','scripts/check-browser.mjs','scripts/task-runtime.mjs','scripts/protected-config.mjs',
            '.github/actions/check/action.yml']) put(product+file,'fixture');
        execFileSync('git',['init','--quiet'],{cwd}); execFileSync('git',['add','.'],{cwd});
        const dry = (env={}) => JSON.parse(execFileSync(process.execPath,[join(monorepo,'node_modules/turbo/bin/turbo'),
            'run','test','lint','typecheck','build','test:e2e:local','--filter=@forever-tee/*','--dry=json','--cache=local:rw'],
            {cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,TURBO_TOKEN:'',TURBO_TEAM:'',CI_TASK_RUNTIME:'fixture-runtime',...env}})).tasks;
        const initial=dry(), hash=(tasks,id)=>tasks.find(t=>t.taskId===`@forever-tee/${id}`).hash;
        const changed=(tasks,id)=>assert.notEqual(hash(tasks,id),hash(initial,id),id);
        const same=(tasks,id)=>assert.equal(hash(tasks,id),hash(initial,id),id);
        const app=dry({FOREVER_TEE_API_URL:'https://changed.example',NEXT_PUBLIC_FEATURE:'changed'});
        for(const id of ['web#build','web#typecheck','web#test']) changed(app,id);
        for(const id of ['contracts#build','contracts#lint','api#build','api#test','video-renderer#test']) same(app,id);
        for(const env of [{CI_TASK_RUNTIME:'other-platform'},{NODE_OPTIONS:'--no-warnings'},{CI:'different'}]) {
            const tasks=dry(env); for(const id of ['web#build','api#test','video-renderer#build','contracts#lint']) changed(tasks,id);
        }
        const mutate=(file,check)=>{ const before=readFileSync(join(cwd,file)); try {put(file,Buffer.concat([before,Buffer.from('\n// changed')]));check(dry());}finally{put(file,before);} };
        for(const file of ['bun.lock',...Object.values(patches)]) mutate(file,tasks=>{for(const id of ['web#build','api#test','video-renderer#build','contracts#build'])changed(tasks,id);});
        mutate(product+'packages/contracts/src/design.ts',tasks=>{changed(tasks,'web#build');changed(tasks,'api#test');same(tasks,'video-renderer#test');});
        mutate(product+'packages/contracts/src/product-mockup-geometry.js',tasks=>{changed(tasks,'video-renderer#build');changed(tasks,'video-renderer#test');});
        mutate(product+'apps/web/src/page.tsx',tasks=>{changed(tasks,'web#test');same(tasks,'api#test');});
        mutate(product+'workers/print-executor/src/index.ts',tasks=>{for(const id of ['api#test','api#typecheck','api#lint'])changed(tasks,id);for(const id of ['web#test:e2e:local','web#build','contracts#build','video-renderer#test'])same(tasks,id);});
        mutate(product+'scripts/release-coordinator.mjs',tasks=>same(tasks,'web#test:e2e:local'));
        for(const file of ['scripts/check-browser.mjs','.github/actions/check/action.yml','assets/lifestyle/featured-blank-white.png'])mutate(product+file,tasks=>changed(tasks,'web#test:e2e:local'));
        put(product+'apps/web/.env.production.local','FOREVER_TEE_API_URL=https://file.example'); const envFile=dry();changed(envFile,'web#build');changed(envFile,'web#typecheck');same(envFile,'api#build');
        const env=validationEnvironment({GITHUB_SHA:'a'.repeat(40),VERCEL_GIT_COMMIT_SHA:'b'.repeat(40)});assert.equal(env.GITHUB_SHA,'');assert.equal(env.VERCEL_GIT_COMMIT_SHA,'');
    } finally { rmSync(cwd,{recursive:true,force:true}); }
});
test('runtime identity includes the exact Node, platform, architecture and hosted image', () => {
    const env = { ImageOS: 'ubuntu24', ImageVersion: '20260901.1' }, runtime = { version: 'v24.13.1', platform: 'linux', arch: 'x64' };
    const initial = taskRuntimeKey(env, runtime);
    for (const delta of [{ version: 'v24.14.0' }, { platform: 'darwin' }, { arch: 'arm64' }])
        assert.notEqual(initial, taskRuntimeKey(env, { ...runtime, ...delta }));
    assert.notEqual(initial, taskRuntimeKey({ ...env, ImageVersion: '20260902.1' }, runtime));
    assert.notEqual(taskRuntimeKey({}, runtime), taskRuntimeKey({ VERCEL: '1' }, runtime));
});
test('cache reports mark restored successes as historical and never copy arbitrary summary fields', () => {
    const report = cacheReport([{ turboVersion: '2.8.12', environmentVariables: { SECRET: 'do-not-copy' }, tasks: [
                { taskId: 'build', hash: 'abc', cache: { status: 'HIT', remote: true, timeSaved: 9000 }, execution: { exitCode: 0, startTime: 1, endTime: 3 } },
                { taskId: 'test', cache: { status: 'MISS' }, execution: { exitCode: 0, startTime: 1, endTime: 40 } },
                { taskId: 'failed', cache: { status: 'MISS' }, execution: { exitCode: 1, startTime: 1, endTime: 40 } },
            ] }]);
    assert.equal(report.runs[0].tasks[0].executed, false);
    assert.equal(report.runs[0].tasks[0].elapsedMs, 2);
    assert.equal(report.runs[0].tasks[1].executed, true);
    assert.equal(report.runs[0].tasks[2].executed, false);
    assert.doesNotMatch(JSON.stringify(report), /do-not-copy|timeSaved/);
});
test('Vercel uses the runtime wrapper from the configured app root', () => {
    const config = JSON.parse(resolveProtectedTemplate(readFileSync(join(root, 'apps/web/vercel.json'), 'utf8')));
    const [command, ...args] = config.buildCommand.split(' ');
    assert.equal(command, 'node');
    const output = execFileSync(process.execPath, [...args, '--dry=json', '--cache=local:rw'], {
        cwd: join(root, 'apps/web'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, VERCEL: '1', TURBO_TOKEN: '', TURBO_TEAM: '' },
    });
    const summary = JSON.parse(output);
    assert.ok(summary.tasks.some(task => task.taskId === '@forever-tee/web#build'));
    assert.ok(summary.globalCacheInputs.environmentVariables.configured.some(value => value.startsWith('CI_TASK_RUNTIME=')));
});
test('release-candidate validation executes again even when Turbo has a successful cached result', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fresh-validation-'));
    const cwd = join(directory, 'repo');
    mkdirSync(cwd);
    try {
        writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'fresh-fixture', private: true, packageManager: JSON.parse(readFileSync(join(root, '../../package.json'), 'utf8')).packageManager,
            scripts: { count: 'node count.mjs' } }));
        writeFileSync(join(cwd, 'count.mjs'), `import {appendFileSync} from 'node:fs'; appendFileSync(new URL('../counter', import.meta.url), 'x');`);
        writeFileSync(join(cwd, 'turbo.json'), JSON.stringify({ tasks: { count: { outputs: [] } } }));
        writeFileSync(join(cwd, '.gitignore'), 'node_modules/\n.turbo/\n');
        execFileSync('bun', ['install', '--ignore-scripts'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        execFileSync('git', ['init', '--quiet'], { cwd });
        execFileSync('git', ['add', '.'], { cwd });
        const run = (env, extra = []) => execFileSync(process.execPath, [join(root, '../../node_modules/turbo/bin/turbo'), ...taskRuntimeArgs(['run', 'count', ...extra], env)], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TURBO_TOKEN: '', TURBO_TEAM: '' } });
        const first = run({}), second = run({});
        assert.equal(readFileSync(join(directory, 'counter'), 'utf8'), 'x', first + second);
        run({ CI_FRESH_VALIDATION: 'true' }, ['--cache', 'local:rw']);
        assert.equal(readFileSync(join(directory, 'counter'), 'utf8'), 'xx');
    }
    finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
