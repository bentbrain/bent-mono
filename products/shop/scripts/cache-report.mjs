import { resolveProtectedTemplate } from "./protected-config.mjs";
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
// Do not publish environment values, replayed logs or the raw Turbo summaries.
// A hit's original duration is not a fresh test execution or billed time saved.
export function cacheReport(summaries) {
    return { schemaVersion: 1, runs: summaries.map(run => ({
            turboVersion: run.turboVersion,
            startedAt: run.execution?.startTime,
            endedAt: run.execution?.endTime,
            exitCode: run.execution?.exitCode,
            tasks: run.tasks.map(task => ({ task: task.taskId, hash: task.hash,
                cache: task.cache?.status ?? 'UNKNOWN', local: task.cache?.local === true,
                remote: task.cache?.remote === true,
                executed: task.cache?.status === 'MISS' && task.execution?.exitCode === 0,
                elapsedMs: typeof task.execution?.endTime === 'number' && typeof task.execution?.startTime === 'number'
                    ? task.execution.endTime - task.execution.startTime : null,
            })),
        })) };
}
if (import.meta.main) {
    const directory = '.turbo/runs';
    const paths = await readdir(directory).catch(error => {
        if (error.code === 'ENOENT')
            return [];
        throw error;
    });
    const runs = await Promise.all(paths.filter(path => path.endsWith('.json')).map(async (path) => JSON.parse(resolveProtectedTemplate(await readFile(join(directory, path), 'utf8')))));
    const report = cacheReport(runs.sort((a, b) => a.execution.startTime - b.execution.startTime));
    if (!process.argv[2])
        throw Error('Supply a cache report output path.');
    await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n');
    for (const run of report.runs) {
        const hits = run.tasks.filter(task => task.cache === 'HIT');
        console.log(`Turbo ${run.turboVersion}: ${hits.length}/${run.tasks.length} task hits, ${hits.filter(task => task.remote).length} remote. Cached logs are historical.`);
    }
}
