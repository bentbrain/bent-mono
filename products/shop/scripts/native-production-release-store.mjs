import { protectedConfig } from "./protected-config.mjs";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertProductionContext } from "./native-production-ci.mjs";
const BUCKET = "forever-tee-video-production-" + protectedConfig("awsAccountId") + "-ap-southeast-2";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const check = value => { if (!value)
    throw new Error("Production release storage verification failed; no artifact overwritten."); };
export function immutableObjectVersion(result) {
    check(result && typeof result.VersionId === "string" && result.VersionId.length > 0 && result.VersionId !== "null" &&
        Number.isSafeInteger(result.ContentLength) && result.ContentLength > 0 && result.ContentLength <= 65536 &&
        result.ServerSideEncryption === "AES256" && result.DeleteMarker !== true);
    return result.VersionId;
}
export async function productionReleaseStore(env, call) {
    assertProductionContext(env);
    check(env.RUNNER_TEMP?.startsWith("/") && process.platform === "linux");
    const directory = await mkdtemp(join(env.RUNNER_TEMP, "production-evidence-"));
    const bucket = ["--bucket", BUCKET, "--expected-bucket-owner", protectedConfig("awsAccountId")];
    const readObject = async (key, version) => {
        const path = join(await mkdtemp(join(directory, "read-")), "object");
        await call(["s3api", "get-object", ...bucket, "--key", key, "--version-id", version, path]);
        return readFile(path);
    };
    const read = async (reference) => {
        check(/^source\/releases\/native-[1-9][0-9]+\/[a-z0-9-]+\.(?:json|js|tfplan)$/.test(reference.key) &&
            typeof reference.version === "string" && reference.version.length > 0 && reference.version !== "null" && /^[a-f0-9]{64}$/.test(reference.sha256));
        const bytes = await readObject(reference.key, reference.version);
        check(sha(bytes) === reference.sha256);
        return bytes;
    };
    const readSingle = async (runId, name) => {
        check(/^[1-9][0-9]+$/.test(runId) && /^[a-z0-9-]+\.json$/.test(name));
        const key = `source/releases/native-${runId}/${name}`;
        const metadata = await call(["s3api", "head-object", ...bucket, "--key", key]);
        const version = immutableObjectVersion(metadata), bytes = await readObject(key, version);
        check(bytes.length === metadata.ContentLength);
        return { bytes, reference: { key, version, sha256: sha(bytes) } };
    };
    return { read, readSingle, save: async (name, bytes) => {
            check(/^[a-z0-9-]+\.(?:json|js|tfplan)$/.test(name) && Buffer.isBuffer(bytes));
            const path = join(directory, name);
            await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
            const key = `source/releases/native-${env.GITHUB_RUN_ID}/${name}`;
            const result = await call(["s3api", "put-object", ...bucket, "--key", key, "--if-none-match", "*", "--server-side-encryption", "AES256", "--body", path]);
            const reference = { key, version: result.VersionId, sha256: sha(bytes) };
            await read(reference);
            return reference;
        } };
}
