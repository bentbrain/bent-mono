import { protectedConfig } from "./protected-config.mjs";
import { execFileSync } from 'node:child_process';
import { lstat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
// Only Turbo's regenerable hash archives are eligible. Never follow symlinks,
// recurse into arbitrary paths, or touch release/qualification artifacts.
export async function trimTaskCache(directory = fileURLToPath(new URL('../../../.turbo/cache', import.meta.url)), maxBytes = 256 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
        throw Error('Invalid task cache byte limit.');
    const stat = await lstat(directory).catch(error => { if (error.code !== 'ENOENT')
        throw error; });
    if (!stat)
        return { removed: 0, bytes: 0 };
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw Error('Task cache must be a real directory.');
    const groups = new Map();
    for (const name of await readdir(directory)) {
        const match = /^([a-f0-9]{16})(?:\.tar\.zst|-meta\.json)$/.exec(name);
        if (!match)
            continue;
        const entry = await lstat(join(directory, name));
        if (!entry.isFile() || entry.isSymbolicLink())
            throw Error('Unexpected task cache entry.');
        const group = groups.get(match[1]) ?? { files: [], bytes: 0, time: 0 };
        group.files.push(name);
        group.bytes += entry.size;
        group.time = Math.max(group.time, entry.mtimeMs);
        groups.set(match[1], group);
    }
    let bytes = 0, removed = 0;
    for (const group of [...groups.values()].sort((a, b) => b.time - a.time)) {
        if (bytes + group.bytes <= maxBytes)
            bytes += group.bytes;
        else {
            for (const file of group.files)
                await unlink(join(directory, file));
            removed++;
        }
    }
    return { removed, bytes };
}
export function closedPullCache(cache, pull) {
    const match = /^refs\/pull\/([1-9][0-9]*)\/merge$/.exec(cache.ref ?? '');
    return Number.isSafeInteger(cache.id) && cache.id > 0 &&
        /^Linux-(?:X64|ARM64)-checks-(?:v1-[a-f0-9]+|v2-[a-f0-9]+-(?:(?:all|repository)-|browser-[12]))-[a-f0-9]{40}$/.test(cache.key ?? '') &&
        match && pull?.number === Number(match[1]) && pull.state === 'closed' &&
        pull.base?.repo?.id === Number(protectedConfig("githubRepositoryId")) && pull.base.repo.owner?.id === Number(protectedConfig("githubOwnerId"));
}
export async function pruneClosedPullCaches(api, { execute = false } = {}) {
    const caches = [];
    for (let page = 1; page <= 10; page++) {
        const result = await api(`actions/caches?per_page=100&page=${page}`);
        if (!Array.isArray(result.actions_caches) || !Number.isSafeInteger(result.total_count) || result.total_count > 1000)
            throw Error('Incomplete cache inventory.');
        caches.push(...result.actions_caches);
        if (caches.length >= result.total_count)
            break;
        if (!result.actions_caches.length || page === 10)
            throw Error('Truncated cache inventory.');
    }
    const pulls = new Map(), removed = [];
    for (const cache of caches) {
        const match = /^refs\/pull\/([1-9][0-9]*)\/merge$/.exec(cache.ref ?? '');
        if (!match || !cache.key?.includes('-checks-v'))
            continue;
        if (!pulls.has(match[1]))
            pulls.set(match[1], await api(`pulls/${match[1]}`));
        if (!closedPullCache(cache, pulls.get(match[1])))
            continue;
        if (execute) {
            // A PR can reopen between planning and deletion. Recheck immediately;
            // delete by immutable cache ID, never a key wildcard or whole ref.
            if (!closedPullCache(cache, await api(`pulls/${match[1]}`)))
                continue;
            await api(`actions/caches/${cache.id}`, 'DELETE');
        }
        removed.push({ id: cache.id, ref: cache.ref, bytes: cache.size_in_bytes });
    }
    return { executed: execute, caches: removed, bytes: removed.reduce((sum, cache) => sum + cache.bytes, 0) };
}
if (import.meta.main) {
    try {
        const { values } = parseArgs({ options: { trim: { type: 'boolean' }, execute: { type: 'boolean' } } });
        if (values.trim) {
            if (values.execute)
                throw Error('--trim only changes the checkout task cache; do not combine it with --execute.');
            console.log(JSON.stringify(await trimTaskCache()));
        }
        else {
            const token = execFileSync('gh', ['auth', 'token', '--user', 'bentbrain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
            const api = async (path, method = 'GET') => {
                const response = await fetch(`https://api.github.com/repos/bentbrain/bent-mono/${path}`, {
                    method, redirect: 'error', signal: AbortSignal.timeout(30000),
                    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
                });
                if (!response.ok)
                    throw Error(`Cache operation returned ${response.status}.`);
                return response.status === 204 ? null : response.json();
            };
            console.log(JSON.stringify(await pruneClosedPullCaches(api, { execute: values.execute }), null, 2));
        }
    }
    catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
