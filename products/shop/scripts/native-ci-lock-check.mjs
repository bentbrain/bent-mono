import { protectedConfig } from "./protected-config.mjs";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { createDevelopmentCICall, STATE_BUCKET, STATE_KMS } from "./native-ci-aws.mjs";
const KEY = "story-video/development/terraform.tfstate.tflock";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const check = condition => { if (!condition)
    throw new Error("CI state locking check failed; inspect the owned lock before continuing."); };
export async function expectServiceFailure(operation, expectedCode) {
    try {
        await operation();
    }
    catch (error) {
        if (error.code === expectedCode)
            return;
        throw new Error("CI negative check returned an unexpected service response.");
    }
    throw new Error("CI negative check unexpectedly succeeded. Stop and inspect storage permissions.");
}
export async function checkOwnedLock({ call, body, path, read, runId }) {
    const bucket = ["--bucket", STATE_BUCKET, "--expected-bucket-owner", protectedConfig("awsAccountId")];
    const lock = [...bucket, "--key", KEY];
    // Never replace an existing Terraform/migration lock or touch the state data.
    await expectServiceFailure(() => call(["s3api", "head-object", ...lock]), "404");
    const create = ["s3api", "put-object", ...lock, "--body", path, "--if-none-match", "*"];
    await expectServiceFailure(() => call(create), "AccessDenied");
    await expectServiceFailure(() => call(["s3api", "put-object", ...bucket, "--key", `story-video/ci-denied-probe/${runId}`,
        "--body", path, "--if-none-match", "*", "--server-side-encryption", "aws:kms", "--ssekms-key-id", STATE_KMS]), "AccessDenied");
    const encryptedCreate = [...create, "--server-side-encryption", "aws:kms", "--ssekms-key-id", STATE_KMS];
    const owned = await call(encryptedCreate);
    check(typeof owned.ETag === "string" && owned.VersionId && owned.ServerSideEncryption === "aws:kms" && owned.SSEKMSKeyId === STATE_KMS);
    // If any check fails or acceptance is uncertain, leave the lock for inspection.
    // No finally/unconditional deletion can clear another writer's lock.
    await expectServiceFailure(() => call(encryptedCreate), "PreconditionFailed");
    const metadata = await call(["s3api", "get-object", ...lock, `${path}.readback`]);
    check(metadata.ETag === owned.ETag && metadata.VersionId === owned.VersionId && sha(await read(`${path}.readback`)) === sha(body));
    await call(["s3api", "delete-object", ...lock, "--if-match", owned.ETag]);
    await expectServiceFailure(() => call(["s3api", "head-object", ...lock]), "404");
    return { stateLockVerified: true, kmsWriteDenialVerified: true, otherKeyWriteDenied: true,
        conditionalContentionVerified: true, ownedLockReleased: true, stateDataTouched: false };
}
export async function runLockCheck(env = process.env) {
    const call = await createDevelopmentCICall(env);
    check(typeof env.RUNNER_TEMP === "string" && isAbsolute(env.RUNNER_TEMP));
    process.umask(0o077);
    const directory = await mkdtemp(join(env.RUNNER_TEMP, "native-state-check-"));
    const path = join(directory, "lock.json");
    const body = JSON.stringify({ ID: randomUUID(), Operation: "CI conditional lock check", Info: `Actions ${env.GITHUB_RUN_ID}`,
        Who: "bentbrain/bent-mono", Version: "1.12.2", Created: new Date().toISOString(), Path: `${STATE_BUCKET}/${KEY.slice(0, -7)}` });
    await writeFile(path, body, { mode: 0o600, flag: "wx" });
    return { ...await checkOwnedLock({ call, body, path, read: readFile, runId: env.GITHUB_RUN_ID }), runId: env.GITHUB_RUN_ID, sourceCommit: env.GITHUB_SHA };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        console.info(JSON.stringify(await runLockCheck()));
    }
    catch {
        console.error("CI state lock check failed. Inspect this run and any owned lock; no state data was intentionally changed.");
        process.exitCode = 1;
    }
}
