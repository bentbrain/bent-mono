import { resolveProtectedTemplate } from "./protected-config.mjs";
import { readFileSync } from "node:fs";
// Reviewed data on protected main. Identity, artifact integrity and live cloud
// qualification are still independently enforced by the existing release code.
export function validatePromotionManifest(value) {
    const check = (condition, reason) => { if (!condition)
        throw Error(`Invalid promotion manifest: ${reason}`); };
    const commit = value => /^[a-f0-9]{40}$/.test(value ?? "");
    const run = value => Number.isSafeInteger(value) && value > 0;
    const report = value => typeof value === "string" && /^docs\/[a-z0-9-]+\.json$/.test(value);
    check(value?.schemaVersion === 1, "schema");
    check(/^[a-f0-9]{64}$/.test(value.candidate?.sourceDigest ?? "") && /^sha256:[a-f0-9]{64}$/.test(value.candidate?.imageDigest ?? "") &&
        run(value.candidate?.buildRunId) && commit(value.candidate?.sourceCommit), "candidate");
    check(/^native-\d+$/.test(value.qualification?.releaseId ?? "") && run(value.qualification?.runId) && commit(value.qualification?.sourceCommit), "qualification");
    check(report(value.phone?.path) && typeof value.phone?.ownerResponse === "string" && value.phone.ownerResponse.trim().length > 0 &&
        /^[a-f0-9-]{36}$/.test(value.phone?.workerVersionId ?? "") && Array.isArray(value.phone?.requestedChecks) &&
        value.phone.requestedChecks.length >= 6 && value.phone.requestedChecks.every(item => typeof item === "string" && item.trim().length > 0), "phone acceptance");
    check(report(value.alertDelivery?.path) && run(value.alertDelivery?.runId) && commit(value.alertDelivery?.sourceCommit), "alert receipt");
    return value;
}
export const promotionManifest = validatePromotionManifest(JSON.parse(resolveProtectedTemplate(readFileSync(new URL("../infra/story-video-lambda/production-promotion.json", import.meta.url), "utf8"))));
