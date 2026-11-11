import { protectedConfig } from "./protected-config.mjs";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDevelopmentCICall } from "./native-ci-aws.mjs";
const BUCKET = "forever-tee-video-development-" + protectedConfig("awsAccountId") + "-ap-southeast-2";
const PRODUCTION_EVIDENCE_RUN_ID = protectedConfig("resource_8d0190ecec7d");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const check = value => { if (!value)
    throw new Error("Native release evidence verification failed; no evidence was overwritten."); };
export function developmentReleaseObjectKey(env, name) {
    const parts = /^(?<stem>[a-z-]+)(?<extension>\.(?:json|tfplan|js|zip))$/.exec(name);
    const stem = parts?.groups?.stem, extension = parts?.groups?.extension;
    check(typeof stem === "string" && typeof extension === "string" && /^\d+$/.test(env.GITHUB_RUN_ID ?? ""));
    if (!["qualify-all", "qualify-components", "cleanup-qualification"].includes(env.NATIVE_OPERATION))
        return `source/releases/native-${env.GITHUB_RUN_ID}/${name}`;
    check(/^native-\d+$/.test(env.NATIVE_VERIFY_RELEASE ?? ""));
    return `source/releases/native-${PRODUCTION_EVIDENCE_RUN_ID}/${stem}-${env.NATIVE_VERIFY_RELEASE}-run-${env.GITHUB_RUN_ID}${extension}`;
}
export async function createDevelopmentReleaseStore(env = process.env, run) {
    const call = await createDevelopmentCICall(env, run);
    check(env.RUNNER_TEMP?.startsWith("/") && env.GITHUB_WORKFLOW_REF === `bentbrain/bent-mono/.github/workflows/native-development.yml@${env.GITHUB_REF}`);
    const directory = await mkdtemp(join(env.RUNNER_TEMP, "native-evidence-"));
    const bucket = ["--bucket", BUCKET, "--expected-bucket-owner", protectedConfig("awsAccountId")];
    const read = async (ref) => {
        check(/^source\/releases\/native-\d+\/[a-z0-9-]+\.(?:json|tfplan|js|zip)$/.test(ref.key) &&
            typeof ref.version === "string" && ref.version.length > 0 && ref.version !== "null" && /^[a-f0-9]{64}$/.test(ref.sha256));
        const output = join(await mkdtemp(join(directory, "read-")), "object");
        await call(["s3api", "get-object", ...bucket, "--key", ref.key, "--version-id", ref.version, output]);
        const bytes = await readFile(output);
        check(hash(bytes) === ref.sha256);
        return bytes;
    };
    return { read, save: async (name, bytes) => {
            if (env.NATIVE_OPERATION === "stage-forward-recovery-authority")
                check(["forward-recovery-snapshot.json", "forward-recovery-authority.json"].includes(name));
            if (env.NATIVE_OPERATION === "stage-forward-completion-authority")
                check(["completion-snapshot.json", "completion-authority.json"].includes(name));
            if (env.NATIVE_OPERATION === "complete-forward-release")
                check(["completion-executor-foundation.json", "completion-prepared.json", "completion-deployed-executor.json", "completion-command-diagnostic.json", "completion-api-content-diagnostic.json", "completion-executor-content-diagnostic.json",
                    "completion-verification-prepared.json", "completion-verification-evidence.json", "completion-verification-executor.json"].includes(name));
            check(/^[a-z-]+\.(?:json|tfplan|js|zip)$/.test(name) && Buffer.isBuffer(bytes));
            const file = join(directory, name);
            await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
            const key = developmentReleaseObjectKey(env, name);
            const saved = await call(["s3api", "put-object", ...bucket, "--key", key, "--body", file, "--if-none-match", "*", "--server-side-encryption", "AES256"]);
            const ref = { key, version: saved.VersionId, sha256: hash(bytes) };
            await read(ref);
            return ref;
        } };
}
