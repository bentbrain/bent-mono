import { protectedConfig } from "./protected-config.mjs";
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closedPullCache, pruneClosedPullCaches, trimTaskCache } from './actions-cache.mjs';
const cache = { id: 10, ref: 'refs/pull/123/merge', key: `Linux-X64-checks-v1-abcdef-${'a'.repeat(40)}`, size_in_bytes: 20 };
const pull = { number: 123, state: 'closed', base: { repo: { id: Number(protectedConfig("githubRepositoryId")), owner: { id: Number(protectedConfig("githubOwnerId")) } } } };
test('cache pruning only selects closed personal PR task caches, never main or release artifacts', () => {
    assert.ok(closedPullCache(cache, pull));
    for (const change of [{ ref: 'refs/heads/main' }, { key: 'release-evidence' }, { key: 'node-cache-Linux-x64-pnpm' }, { id: '../1' }])
        assert.ok(!closedPullCache({ ...cache, ...change }, pull));
    assert.ok(!closedPullCache(cache, { ...pull, state: 'open' }));
    assert.ok(!closedPullCache(cache, { ...pull, base: {} }));
    for (const role of ['all-', 'repository-', 'browser-1', 'browser-2']) {
        assert.ok(closedPullCache({ ...cache, key: `Linux-X64-checks-v2-abcdef-${role}-${'a'.repeat(40)}` }, pull));
    }
    for (const role of ['browser-', 'browser-3', 'unknown-']) {
        assert.ok(!closedPullCache({ ...cache, key: `Linux-X64-checks-v2-abcdef-${role}-${'a'.repeat(40)}` }, pull));
    }
});
test('remote pruning defaults to read-only and rechecks reopened PRs before deletion', async () => {
    const calls = [];
    let reopened = false, reads = 0;
    const api = async (path, method) => {
        calls.push([path, method]);
        if (path.startsWith('actions/caches?'))
            return { total_count: 1, actions_caches: [cache] };
        if (path.startsWith('pulls/'))
            return { ...pull, state: reopened && ++reads > 1 ? 'open' : 'closed' };
        assert.equal(path, 'actions/caches/10');
        assert.equal(method, 'DELETE');
    };
    assert.equal((await pruneClosedPullCaches(api)).bytes, 20);
    assert.ok(calls.every(([, method]) => method === undefined));
    assert.equal((await pruneClosedPullCaches(api, { execute: true })).caches.length, 1);
    reopened = true;
    assert.equal((await pruneClosedPullCaches(api, { execute: true })).caches.length, 0);
});
test('task snapshots retain the newest archives within the byte ceiling and refuse symlinks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'task-trim-'));
    try {
        for (const [hash, time] of [['a'.repeat(16), 1], ['b'.repeat(16), 2]]) {
            for (const suffix of ['.tar.zst', '-meta.json']) {
                const file = join(directory, hash + suffix);
                await writeFile(file, '12345');
                await utimes(file, time, time);
            }
        }
        await writeFile(join(directory, 'release-receipt.json'), 'preserve');
        assert.deepEqual(await trimTaskCache(directory, 10), { removed: 1, bytes: 10 });
        assert.equal(await readFile(join(directory, `${'b'.repeat(16)}.tar.zst`), 'utf8'), '12345');
        assert.equal(await readFile(join(directory, 'release-receipt.json'), 'utf8'), 'preserve');
        await symlink(join(directory, 'release-receipt.json'), join(directory, `${'c'.repeat(16)}.tar.zst`));
        await assert.rejects(trimTaskCache(directory), /Unexpected/);
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
});
