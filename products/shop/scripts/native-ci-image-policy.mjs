import { protectedConfig } from "./protected-config.mjs";
// Retain immutable images and their evidence, but never deploy a known-broken
// image as a candidate or rollback target. The first real Development cohort
// proved this digest cannot boot under Lambda's non-root runtime user.
const rejected = new Set([
    "sha256:" + protectedConfig("resource_5447862d5917"),
]);
export function assertDeployableImage(digest) {
    if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? "") || rejected.has(digest)) {
        throw new Error("Native image target rejected: invalid digest or failed cloud qualification. Existing image/evidence were retained.");
    }
}
