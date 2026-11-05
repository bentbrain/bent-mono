import { resolveProtectedTemplate } from "./protected-config.mjs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const proposal = JSON.parse(resolveProtectedTemplate(await readFile(new URL("./fixtures/content/featured-396-398.json", import.meta.url), "utf8")));
const SHIRT = "a51b7acf-77e9-4762-83c4-62d96dd8942c";
const TOTE = "97b629d7-1d3b-4d2a-a586-537168141e97";
const check = (condition, message) => {
    if (!condition)
        throw new Error(message);
};
// Offline review only. No network, subprocess, credentials, generated UUIDs or writes.
export function featuredContentPlan(inventory, attachment) {
    check(Array.isArray(inventory) && inventory.length === 4 && inventory.every(result => result?.success === true && Array.isArray(result.results) &&
        result.meta?.changed_db === false && result.meta?.rows_written === 0), "Expected four successful read-only results from featured-content-396-398.sql.");
    const [anchors, families, state, current] = inventory.map(result => result.results);
    check(anchors.length === proposal.products.length, "Missing or extra requested products.");
    check(state.length === 1 && Number.isSafeInteger(state[0].revision) && state[0].revision >= 0, "Missing featured configuration revision.");
    check(attachment.byteSize === proposal.videoAttachment.byteSize &&
        attachment.sha256 === proposal.videoAttachment.sha256, "Issue #398 attachment bytes do not match the reviewed original.");
    const reports = proposal.products.map(({ slot, productId, expected }) => {
        const matches = anchors.filter(row => row.id === productId);
        check(matches.length === 1 && Object.entries(expected).every(([key, value]) => matches[0][key] === value), `Product ${productId} changed since review. Inspect and review a new proposal.`);
        const family = families.filter(row => row.design_id === expected.design_id &&
            row.design_revision_id === expected.design_revision_id && row.status === "active");
        check(family.length === 2 && [SHIRT, TOTE].every(base => family.filter(row => row.base_product_id === base).length === 1) &&
            family.some(row => row.id === productId && row.base_product_id === SHIRT) && new Set(family.map(row => row.id)).size === 2, `Product ${productId} needs exactly one active shirt and tote at its reviewed revision.`);
        return { slot, productId, family: family.map(row => {
                check(Number.isSafeInteger(row.paid_order_line_count) && row.paid_order_line_count >= 0, "Missing paid-order reference count.");
                const videos = JSON.parse(row.videos);
                const colours = row.base_product_id === SHIRT ? ["Black", "White"] : ["Black", "Cream"];
                check(Array.isArray(videos), "Invalid story-video inventory.");
                const ready = colours.every(colour => {
                    const jobs = videos.filter(video => video.colour === colour);
                    return jobs.length === 1 && jobs[0].status === "ready" &&
                        jobs[0].rendererVersion === "story-video-renderer-v7" &&
                        jobs[0].storyKey === `story-videos/v7/${row.design_revision_id}/${row.id}/${colour.toLowerCase()}.mp4`;
                });
                return { productId: row.id, paidOrderLineCount: row.paid_order_line_count,
                    videoLedgerReady: ready, videoObjectVerified: false,
                    action: ready ? "retain-existing-story-videos" : "inspect-missing-or-failed-story-videos" };
            }) };
    });
    check(current.length >= 1 && current.length <= 6 && current.every(row => Number.isInteger(row.slot) &&
        row.slot >= 1 && row.slot <= 6 && typeof row.product_id === "string") &&
        new Set(current.map(row => row.slot)).size === current.length &&
        new Set(current.map(row => row.product_id)).size === current.length, "Invalid current featured slots.");
    return {
        schemaVersion: 1, mode: "review-only", sourceCommit: proposal.sourceCommit,
        environment: proposal.environment, executionAuthorized: false,
        attachmentVerified: true, unresolved: proposal.unresolved,
        // These are candidate inputs, never an instruction or authorization to dispatch.
        candidateFeaturedWorkflowInputs: {
            environment: proposal.environment, operation: "replace", expected_revision: String(state[0].revision),
            ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`slot_${i + 1}`,
                proposal.products.find(product => product.slot === i + 1)?.productId ?? ""])),
        },
        slotChanges: Array.from({ length: 6 }, (_, i) => ({ slot: i + 1,
            before: current.find(row => row.slot === i + 1)?.product_id ?? null,
            after: proposal.products.find(product => product.slot === i + 1)?.productId ?? null,
        })).filter(row => row.before !== row.after),
        products: reports,
    };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    check(process.argv.length === 4, "Usage: node scripts/featured-content-plan.mjs INVENTORY_JSON ORIGINAL_ISSUE_398_ATTACHMENT");
    const [inventory, attachment] = await Promise.all([readFile(process.argv[2], "utf8"), readFile(process.argv[3])]);
    console.info(JSON.stringify(featuredContentPlan(JSON.parse(inventory), {
        byteSize: attachment.byteLength, sha256: createHash("sha256").update(attachment).digest("hex"),
    }), null, 2));
}
