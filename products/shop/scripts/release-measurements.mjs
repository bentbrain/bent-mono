import { resolveProtectedTemplate } from "./protected-config.mjs";
import { readFile } from 'node:fs/promises';
import { timingDistribution, elapsedMs } from './release-timings.mjs';
const completed = journal => journal.stages.length > 0 && journal.stages.every(stage => stage.status === 'complete');
function promotedPreview(journals, production, policyVersion) {
    const candidates = journals.filter(journal => journal.target === 'preview' && journal.source === production.source &&
        (policyVersion === undefined || journal.policyVersion === policyVersion));
    const pair = production.promotion?.qualification?.expectedPair;
    const acceptance = production.promotion?.acceptance;
    // Native source alone cannot distinguish releases at the same commit. Keep
    // failed/incomplete attempts in the lineage search; they are not older success.
    if (pair) {
        if (pair.sourceCommit !== production.source || !/^native-\d+$/.test(pair.releaseId ?? '') ||
            acceptance && (acceptance.developmentReleaseId !== pair.releaseId || acceptance.sourceCommit !== production.source ||
                acceptance.imageDigest !== pair.imageDigest))
            return null;
        const matches = candidates.filter(journal => journal.stages.some(stage => stage.workflow === 'native-development.yml' && stage.inputs?.operation === 'release' && `native-${stage.runId}` === pair.releaseId));
        if (matches.length !== 1)
            return null;
        const preview = matches[0], browsers = preview.stages.filter(stage => stage.workflow === 'preview-smoke.yml');
        if (acceptance && browsers.length && (browsers.length !== 1 || browsers[0].runId !== acceptance.previewRunId))
            return null;
        return completed(preview) && elapsedMs(preview.stages.at(-1).completedAt, production.createdAt) !== null ? preview : null;
    }
    // Web-only journals have no native promotion input. An unambiguous complete
    // source journey is usable, but a second attempt makes its lineage unknown.
    if (production.stages.some(stage => stage.workflow === 'native-production.yml') || candidates.length !== 1)
        return null;
    const preview = candidates[0];
    return completed(preview) && elapsedMs(preview.stages.at(-1).completedAt, production.createdAt) !== null ? preview : null;
}
export function releaseMeasurements(journals) {
    const seen = new Set(), groups = new Map();
    const samples = journals.map(journal => {
        if (journal.schemaVersion !== 1 || journal.repository !== 'bentbrain/bent-mono' || !Array.isArray(journal.stages) ||
            seen.has(journal.id))
            throw Error('Distinct personal release journals required.');
        seen.add(journal.id);
        const complete = completed(journal);
        const elapsed = complete ? elapsedMs(journal.createdAt, journal.stages.at(-1).completedAt) : null;
        const recovered = journal.stages.some(stage => stage.recovery);
        const cache = ['cold', 'warm'].includes(journal.cacheState) ? journal.cacheState : 'unknown';
        const kind = journal.selection ? Object.entries(journal.selection.components).filter(([, changed]) => changed).map(([name]) => name).sort().join('+') : 'full';
        const group = `policy-${journal.policyVersion ?? 1}/${journal.target}/${journal.selection?.mode ?? journal.mode}/${kind}/${cache}/${recovered ? 'recovered' : 'ordinary'}`;
        const sample = { id: journal.id, source: journal.source, target: journal.target, group, complete, elapsedMs: elapsed, recovered, cacheState: cache };
        if (!groups.has(group))
            groups.set(group, []);
        groups.get(group).push(sample);
        return sample;
    });
    const reviews = samples.filter(sample => sample.target === 'production').map(production => {
        const current = journals.find(journal => journal.id === production.id);
        const preview = promotedPreview(journals, current);
        return { source: production.source, reviewAndCoordinationMs: preview ? elapsedMs(preview.stages.at(-1).completedAt, current.createdAt) : null };
    });
    const journeys = journals.filter(journal => journal.target === 'production' && journal.policyVersion === 3).map(production => {
        const preview = promotedPreview(journals, production, 3);
        const complete = completed(production);
        const routine = Boolean(preview && preview.selection?.routineTargetMs === 600000);
        const duration = preview && complete ? elapsedMs(preview.createdAt, production.stages.at(-1).completedAt) : null;
        return { source: production.source, previewJournalId: preview?.id ?? null, productionJournalId: production.id,
            routine, targetMs: routine ? 600000 : null, elapsedMs: duration, withinTarget: routine && duration !== null ? duration <= 600000 : null };
    });
    return { schemaVersion: 1, samples, journeys, groups: [...groups].map(([group, items]) => ({ group, attempts: items.length, incomplete: items.filter(item => !item.complete).length,
            ...timingDistribution(items.map(item => item.elapsedMs)) })), reviews, billedRunnerMinutes: null,
        note: 'Median and p95 require ten comparable completed samples per group. Unknown cache state stays separate. Review gaps include coordination, not only human time. Billing requires separate GitHub billing data.' };
}
if (import.meta.main) {
    if (!process.argv.slice(2).length)
        throw Error('Supply saved release journal paths.');
    const journals = await Promise.all(process.argv.slice(2).map(async (path) => JSON.parse(resolveProtectedTemplate(await readFile(path, 'utf8')))));
    console.info(JSON.stringify(releaseMeasurements(journals), null, 2));
}
