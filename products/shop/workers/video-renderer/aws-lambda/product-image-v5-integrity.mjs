import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
export async function productImageV5Inventory(directory, prefix = "") {
    const entries = [];
    for (const name of (await readdir(join(directory, prefix))).sort()) {
        const path = join(prefix, name), info = await lstat(join(directory, path));
        if (info.isSymbolicLink()) throw new Error("Capsule files must be materialized.");
        if (info.isDirectory()) entries.push(...await productImageV5Inventory(directory, path));
        else if (info.isFile()) {
            const bytes = await readFile(join(directory, path));
            entries.push({ path: path.replaceAll("\\", "/"), size: bytes.length, sha256: digest(bytes) });
        }
        else throw new Error("Unsupported capsule file.");
    }
    return entries;
}
export async function verifyProductImageV5Runtime(directory, expectedManifestSha256) {
    const bytes = await readFile(join(directory, "capsule-manifest.json"));
    if (bytes.length > 1048576 || digest(bytes) !== expectedManifestSha256)
        throw new Error("Native v5 binding does not match the capsule manifest.");
    const manifest = JSON.parse(bytes.toString("utf8"));
    if (manifest.schema !== "shop.product-image-v5-local-capsule/v1" || manifest.rendererVersion !== "product-images-v5" ||
        manifest.entry !== "product-image-v5-entry.mjs" || manifest.export !== "handler" || manifest.awsImageQualified !== false ||
        manifest.qualification !== "local-host-capsule" || manifest.runtime?.node !== process.version ||
        manifest.runtime.platform !== process.platform || manifest.runtime.arch !== process.arch ||
        manifest.runtime.nodeAbi !== process.versions.modules)
        throw new Error("Incompatible local native v5 capsule.");
    const files = (await productImageV5Inventory(directory)).filter(file => file.path !== "capsule-manifest.json");
    if (JSON.stringify(files) !== JSON.stringify(manifest.files) || digest(JSON.stringify(files)) !== manifest.filesSha256)
        throw new Error("Native v5 capsule checksum mismatch.");
    return manifest;
}
