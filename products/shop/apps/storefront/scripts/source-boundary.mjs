import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { renderProductDisplay } from "@forever-tee/product-image-renderer";

const artifact = process.argv[2];
const capsule = process.argv[3];
if (!artifact || !capsule)
  throw new Error(
    "Supply the private journey artifact and native capsule directories.",
  );
const { events } = JSON.parse(
  await readFile(resolve(artifact, "events.json"), "utf8"),
);
const observed = events.find(
  (event) =>
    event.operation === "actual-native-v5-input" &&
    event.recipe.view === "flat",
);
if (!observed)
  throw new Error(
    "The journey must record an actual native flat-image recipe.",
  );
const results = [];
for (const kind of ["original", "cutout"]) {
  const input = await readFile(resolve(artifact, `prepared-${kind}.bin`));
  const metadata = await sharp(input).metadata();
  const result = {
    kind,
    input: {
      sha256: createHash("sha256").update(input).digest("hex"),
      bytes: input.length,
      width: metadata.width,
      height: metadata.height,
    },
    recipe: observed.recipe,
  };
  try {
    const output = await renderProductDisplay(
      input,
      observed.recipe,
      resolve(capsule, "assets/lifestyle-v4"),
    );
    const outputMetadata = await sharp(output).metadata();
    result.output = {
      sha256: createHash("sha256").update(output).digest("hex"),
      bytes: output.length,
      width: outputMetadata.width,
      height: outputMetadata.height,
    };
    await writeFile(resolve(artifact, `full-source-${kind}.webp`), output, {
      mode: 0o600,
    });
    result.status = "passed";
  } catch (error) {
    result.status = "failed";
    result.error = error instanceof Error ? error.message : String(error);
  }
  results.push(result);
}
const report = {
  scope: "shared-native-renderer-full-source-boundary",
  actualJourneyNativeInput: {
    width: observed.width,
    height: observed.height,
    sha256: observed.sha256,
  },
  results,
};
await writeFile(
  resolve(artifact, "full-source-native-boundary.json"),
  JSON.stringify(report, null, 2),
  { mode: 0o600 },
);
console.log(JSON.stringify(report));
if (results.some((result) => result.status !== "passed")) process.exitCode = 1;
