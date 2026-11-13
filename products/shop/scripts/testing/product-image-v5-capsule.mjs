import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { productImageV5Inventory, verifyProductImageV5Runtime } from "../../workers/video-renderer/aws-lambda/product-image-v5-integrity.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const shop = join(root, "products/shop");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
async function secureCapsule(directory) {
    await chmod(directory, 0o700);
    for (const name of await readdir(directory)) {
        const path = join(directory, name), info = await lstat(path);
        if (info.isDirectory()) await secureCapsule(path);
        else if (info.isFile()) await chmod(path, 0o600);
        else throw new Error("Capsule files must be materialized.");
    }
}
async function copyFile(source, destination) {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await cp(source, destination, { dereference: true });
}
async function packageProductImageV5Capsule(destination) {
    const output = resolve(destination);
    // Never overwrite a previous capsule or evidence.
    await mkdir(output, { recursive: false, mode: 0o700 });
    const sourceInputs = [], dependencies = [], transformations = [], installed = new Map();
    async function source(path, target) {
        const bytes = await readFile(join(root, path));
        sourceInputs.push({ path, size: bytes.length, sha256: digest(bytes) });
        await copyFile(join(root, path), join(output, target));
    }
    for (const name of ["product-image-v5-handler.mjs", "product-image-v5-entry.mjs", "product-image-v5-integrity.mjs"])
        await source(`products/shop/workers/video-renderer/aws-lambda/${name}`, name);
    const renderer = "products/shop/packages/product-image-renderer";
    for (const name of ["package.json", "src/index.mjs", "src/index.d.ts", "src/execution.mjs", "src/execution.d.ts", "assets/displacement.wasm", "assets/displacement-build.json"])
        await source(`${renderer}/${name}`, `node_modules/@forever-tee/product-image-renderer/${name}`);
    const contracts = "products/shop/packages/contracts";
    for (const name of ["package.json", "src/diagnostics.ts", "src/limits.ts", "src/product-mockup-geometry.js"])
        await source(`${contracts}/${name}`, `node_modules/@forever-tee/contracts/${name}`);
    for (const name of ["diagnostics", "limits"]) {
        const path = `node_modules/@forever-tee/contracts/src/${name}.ts`;
        const original = await readFile(join(output, path));
        const transformed = stripTypeScriptTypes(original.toString("utf8"), { mode: "strip" });
        const destination = path.replace(/\.ts$/, ".mjs");
        await writeFile(join(output, destination), transformed, { mode: 0o600 });
        transformations.push({ input: path, inputSha256: digest(original), output: destination,
            outputSha256: digest(transformed), tool: "node:module.stripTypeScriptTypes", mode: "strip", node: process.version });
    }
    const contractsMetadata = JSON.parse(await readFile(join(output, "node_modules/@forever-tee/contracts/package.json"), "utf8"));
    await copyFile(join(root, contracts, "package.json"), join(output, "source-inputs/contracts-package.json"));
    await writeFile(join(output, "node_modules/@forever-tee/contracts/package.json"), JSON.stringify({ ...contractsMetadata, exports: {
        "./diagnostics": "./src/diagnostics.mjs", "./limits": "./src/limits.mjs", "./product-mockup-geometry": "./src/product-mockup-geometry.js",
    } }, null, 2) + "\n", { mode: 0o600 });
    const assets = "products/shop/apps/web/public/mockups/lifestyle-v4";
    for (const name of (await readdir(join(root, assets))).sort())
        await source(`${assets}/${name}`, `assets/lifestyle-v4/${name}`);
    async function dependency(name, from, optional = false) {
        const require = createRequire(from);
        let metadataPath;
        for (const base of require.resolve.paths(name) ?? []) {
            const candidate = join(base, name, "package.json");
            try {
                await readFile(candidate);
                metadataPath = candidate;
                break;
            }
            catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        if (!metadataPath) {
            if (optional) return;
            throw new Error(`Native dependency unavailable: ${name}`);
        }
        const directory = await realpath(dirname(metadataPath));
        const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
        if (installed.has(name)) {
            if (installed.get(name) !== directory) throw new Error("Conflicting native dependency resolution.");
            return;
        }
        installed.set(name, directory);
        dependencies.push({ name, version: metadata.version, packageSha256: digest(await readFile(join(directory, "package.json"))) });
        await cp(directory, join(output, "node_modules", name), {
            recursive: true, dereference: true,
            filter: path => !relative(directory, path).split(/[\\/]/).includes("node_modules"),
        });
        for (const dep of Object.keys(metadata.dependencies ?? {}).sort())
            await dependency(dep, join(directory, "package.json"));
        for (const dep of Object.keys(metadata.optionalDependencies ?? {}).sort())
            await dependency(dep, join(directory, "package.json"), true);
    }
    await dependency("sharp", join(shop, "packages/product-image-renderer/package.json"));
    const lock = await readFile(join(root, "bun.lock"));
    sourceInputs.push({ path: "bun.lock", size: lock.length, sha256: digest(lock) });
    // Bind the collector itself and the source geometry/WASM inputs as proof inputs.
    for (const path of ["products/shop/scripts/testing/product-image-v5-capsule.mjs", `${renderer}/wasm/src/lib.rs`, `${renderer}/wasm/Cargo.toml`, `${renderer}/wasm/Cargo.lock`]) {
        const bytes = await readFile(join(root, path));
        sourceInputs.push({ path, size: bytes.length, sha256: digest(bytes) });
    }
    await writeFile(join(output, "package.json"), JSON.stringify({ private: true, type: "module", name: "product-image-v5-local-capsule" }) + "\n", { mode: 0o600 });
    await secureCapsule(output);
    const files = await productImageV5Inventory(output);
    const manifest = {
        schema: "shop.product-image-v5-local-capsule/v1", rendererVersion: "product-images-v5",
        entry: "product-image-v5-entry.mjs", export: "handler",
        runtime: { node: process.version, platform: process.platform, arch: process.arch,
            nodeAbi: process.versions.modules, sharp: createRequire(join(output, "package.json"))("sharp").versions },
        qualification: "local-host-capsule", awsImageQualified: false,
        sourceInputs: sourceInputs.sort((a, b) => a.path.localeCompare(b.path)),
        dependencies: dependencies.sort((a, b) => a.name.localeCompare(b.name)), transformations,
        files, filesSha256: digest(JSON.stringify(files)),
    };
    await writeFile(join(output, "capsule-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    return manifest;
}
export async function verifyProductImageV5Capsule(directory) {
    const bytes = await readFile(join(directory, "capsule-manifest.json"));
    return verifyProductImageV5Runtime(directory, digest(bytes));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.length !== 3) throw new Error("Usage: node product-image-v5-capsule.mjs <new-private-directory>");
    const manifest = await packageProductImageV5Capsule(process.argv[2]);
    console.log(JSON.stringify({ files: manifest.files.length, filesSha256: manifest.filesSha256, runtime: manifest.runtime, awsImageQualified: false }));
}
