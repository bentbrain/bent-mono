import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { BUCKET, ACCOUNT, VARIANTS } from "./config.mjs";
import { assetReference, sha256, validateSettings } from "./contract.mjs";
import { aws, isMain, ROOT } from "./local-tools.mjs";

export async function prepareFixture(sourcePath, directory) {
  const source = JSON.parse(await readFile(sourcePath, "utf8"));
  if (!/^[0-9a-f-]{36}$/.test(source.designId ?? "") || typeof source.artworkPath !== "string") {
    throw new Error("Provide a saved design ID, background-removed PNG path, and actual product settings.");
  }
  const settings = Object.fromEntries(["staple-tee", "cotton-tote"].map((slug) => [slug, validateSettings(source.settings?.[slug])]));
  const artwork = await readFile(resolve(dirname(sourcePath), source.artworkPath));
  if (!artwork.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error("The saved background-removed artwork must be PNG.");
  }
  const destination = resolve(directory);
  await mkdir(destination, { recursive: true });
  const uploads = [];
  const save = async (bytes, kind, variantId) => {
    const hash = sha256(bytes);
    const extension = kind === "artwork" ? "png" : VARIANTS[variantId].file.split(".").at(-1);
    const key = kind === "artwork" ? `inputs/artwork/${hash}.png` : `inputs/mockups/${variantId}/${hash}.${extension}`;
    const ref = assetReference({ key, sha256: hash, size: bytes.length }, kind, variantId);
    const path = resolve(destination, `${kind}-${variantId ?? "saved"}.${extension}`);
    await writeFile(path, bytes, { flag: "wx" });
    uploads.push({ ...ref, path, contentType: extension === "webp" ? "image/webp" : "image/png" });
    return ref;
  };
  const artworkRef = await save(artwork, "artwork");
  const variants = [];
  for (const [variantId, product] of Object.entries(VARIANTS)) {
    variants.push({ variantId, settings: settings[product.baseProductSlug],
      mockup: await save(await readFile(resolve(ROOT, "apps/web/public/mockups", product.file)), "mockup", variantId) });
  }
  const fixture = { schemaVersion: 1, designId: source.designId, artwork: artworkRef, variants, uploads };
  const path = resolve(destination, "fixture.json");
  await writeFile(path, `${JSON.stringify(fixture, null, 2)}\n`, { flag: "wx" });
  return path;
}

export async function uploadFixture(fixturePath, call = aws) {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  if (!Array.isArray(fixture.uploads) || fixture.uploads.length !== 5 ||
      !Array.isArray(fixture.variants) || fixture.variants.length !== 4 ||
      new Set(fixture.variants.map((variant) => variant.variantId)).size !== 4) throw new Error("Invalid four-variant fixture.");
  const refs = [assetReference(fixture.artwork, "artwork"), ...fixture.variants.map((variant) => {
    if (!Object.hasOwn(VARIANTS, variant.variantId)) throw new Error("Invalid variant.");
    validateSettings(variant.settings);
    return assetReference(variant.mockup, "mockup", variant.variantId);
  })];
  for (const [index, ref] of refs.entries()) {
    const upload = fixture.uploads[index];
    if (upload.key !== ref.key || upload.sha256 !== ref.sha256 || upload.size !== ref.size ||
        !["image/png", "image/webp"].includes(upload.contentType)) throw new Error("Invalid upload manifest.");
    const bytes = await readFile(upload.path);
    if (bytes.length !== ref.size || sha256(bytes) !== ref.sha256) throw new Error("Local fixture asset changed.");
  }
  await call(["s3api", "head-bucket", "--bucket", BUCKET, "--expected-bucket-owner", ACCOUNT]);
  for (const upload of fixture.uploads) {
    await call(["s3", "cp", upload.path, `s3://${BUCKET}/${upload.key}`, "--only-show-errors",
      "--content-type", upload.contentType, "--metadata", `sha256=${upload.sha256}`]);
    const stored = await call(["s3api", "head-object", "--bucket", BUCKET, "--expected-bucket-owner", ACCOUNT, "--key", upload.key]);
    if (stored.ContentLength !== upload.size || stored.Metadata?.sha256 !== upload.sha256) throw new Error("Uploaded asset verification failed.");
  }
  return { uploaded: fixture.uploads.length, bucket: BUCKET };
}

if (isMain(import.meta.url)) {
  const [command, input, output] = process.argv.slice(2);
  if (command === "prepare" && input && output) console.info(await prepareFixture(resolve(input), output));
  else if (command === "upload" && input && !output) console.info(JSON.stringify(await uploadFixture(resolve(input))));
  else throw new Error("Use: prepare <saved-design.json> <new-directory>, or upload <fixture.json>.");
}
