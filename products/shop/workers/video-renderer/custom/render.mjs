import { appendFile, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { loadFeaturedRenderInputs, sha256 } from "./inputs.mjs";
import { renderFeaturedVideo } from "./renderer.mjs";

const input = await loadFeaturedRenderInputs(process.env);
const outputDirectory = resolve("featured-video-output");
console.info(`Rendering ${input.layers.length} cutouts, finishing on ${input.finalProductId}.`);
const result = await renderFeaturedVideo({ ...input, outputDirectory,
  mockup: await readFile(new URL(`../../../apps/web/public/mockups/${input.mockupFile}`, import.meta.url)) });
const outputs = await Promise.all([result.mp4].map(async path => ({
  file: path.split("/").at(-1), bytes: (await stat(path)).size,
})));
const manifest = {
  schemaVersion: 1, sourceCommit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID,
  environment: process.env.RENDER_ENVIRONMENT, createdAt: new Date().toISOString(),
  featured: input.featured, finalProductId: input.finalProductId,
  baseProductSlug: input.baseProductSlug, color: input.color,
  mockupFile: input.mockupFile, mockupSha256: sha256(await readFile(new URL(`../../../apps/web/public/mockups/${input.mockupFile}`, import.meta.url))),
  layersOuterToInner: input.layers.map(({ artwork, ...metadata }) => ({ ...metadata, artworkBytes: artwork.length })),
  quality: result.quality, frameCount: result.frameCount, outputs,
};
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
  `Rendered ${input.layers.length} current featured cutouts at 2160 × 3840, 60 fps.\n\n` +
  `Final product: \`${input.finalProductId}\`, ${input.baseProductSlug}, ${input.color}.\n\n` +
  "Download the artifact below for featured.mp4.\n\n" +
  "<details><summary>Render details</summary>\n\n```json\n" +
  `${JSON.stringify(manifest, null, 2)}\n` + "```\n</details>\n");
