import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevelopmentReleaseStore, developmentReleaseObjectKey } from "./native-ci-release-store.mjs";
test("ordinary release evidence stays in its Actions run namespace", () => {
    assert.equal(developmentReleaseObjectKey({ GITHUB_RUN_ID: "456", NATIVE_OPERATION: "release" }, "release.json"), "source/releases/native-456/release.json");
});
test("complete qualification evidence uses the fixed Production-readable namespace and an immutable run suffix", () => {
    const env = {
        GITHUB_RUN_ID: "789",
        NATIVE_OPERATION: "qualify-all",
        NATIVE_VERIFY_RELEASE: "native-456",
    };
    assert.equal(developmentReleaseObjectKey(env, "qualification-complete-summary.json"), "source/releases/native-" + protectedConfig("resource_8d0190ecec7d") + "/qualification-complete-summary-native-456-run-789.json");
    assert.equal(developmentReleaseObjectKey(env, "qualification-family-one.json"), "source/releases/native-" + protectedConfig("resource_8d0190ecec7d") + "/qualification-family-one-native-456-run-789.json");
});
test("qualification evidence refuses unpinned release and run identities", () => {
    assert.throws(() => developmentReleaseObjectKey({
        GITHUB_RUN_ID: "789",
        NATIVE_OPERATION: "qualify-all",
        NATIVE_VERIFY_RELEASE: "latest",
    }, "qualification-complete-summary.json"));
    assert.throws(() => developmentReleaseObjectKey({
        GITHUB_RUN_ID: "rerun",
        NATIVE_OPERATION: "qualify-all",
        NATIVE_VERIFY_RELEASE: "native-456",
    }, "qualification-complete-summary.json"));
    assert.throws(() => developmentReleaseObjectKey({
        GITHUB_RUN_ID: "789",
        NATIVE_OPERATION: "qualify-all",
        NATIVE_VERIFY_RELEASE: "native-456",
    }, "../qualification-complete-summary.json"));
});
test('failed cleanup evidence stays outside the successful qualification namespace', () => {
    const env = { GITHUB_RUN_ID: '789', NATIVE_OPERATION: 'cleanup-failed-qualification', NATIVE_VERIFY_RELEASE: 'native-456' };
    assert.equal(developmentReleaseObjectKey(env, 'failed-qualification-cleanup-receipt.json'), 'source/releases/native-789/failed-qualification-cleanup-receipt.json');
});


test("authority staging uses existing CI role, exact create-only names and version/hash readback without write retries", async t => {
    for (const failure of [undefined, "snapshot-ack", "authority-ack", "hash", "version"]) {
        const directory = await mkdtemp(join(tmpdir(), "staging-store-test-"));
        t.after(() => rm(directory, { recursive: true, force: true }));
        const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "bentbrain/bent-mono", GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"),
            GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"), GITHUB_REF: "refs/heads/main", GITHUB_SHA: "a".repeat(40),
            GITHUB_RUN_ID: "456", GITHUB_RUN_ATTEMPT: "1", GITHUB_EVENT_NAME: "workflow_dispatch",
            GITHUB_WORKFLOW_REF: "bentbrain/bent-mono/.github/workflows/native-development.yml@refs/heads/main",
            NATIVE_OPERATION: "stage-forward-recovery-authority", RUNNER_TEMP: directory,
            AWS_REGION: "ap-southeast-2", AWS_DEFAULT_REGION: "ap-southeast-2", AWS_ACCESS_KEY_ID: "synthetic",
            AWS_SECRET_ACCESS_KEY: "synthetic", AWS_SESSION_TOKEN: "synthetic", AWS_PROFILE: "foreign" };
        const calls = [], objects = new Map();
        const run = async (command, args, options) => {
            assert.equal(command, "aws"); calls.push(args);
            assert.equal(options.env.AWS_PROFILE, undefined);
            assert.equal(options.env.AWS_CONFIG_FILE, "/dev/null");
            if (args[0] === "sts") return { stdout: JSON.stringify({ Account: protectedConfig("awsAccountId"),
                Arn: `arn:aws:sts::${protectedConfig("awsAccountId")}:assumed-role/forever-tee-video-development-ci/native-456` }) };
            assert.equal(args[0], "s3api");
            assert.equal(args[args.indexOf("--expected-bucket-owner") + 1], protectedConfig("awsAccountId"));
            const key = args[args.indexOf("--key") + 1];
            assert.match(key, /^source\/releases\/native-456\/forward-recovery-(snapshot|authority)\.json$/);
            if (args[1] === "put-object") {
                assert.equal(options.env.AWS_MAX_ATTEMPTS, "1");
                assert.equal(args[args.indexOf("--if-none-match") + 1], "*");
                assert.equal(args[args.indexOf("--server-side-encryption") + 1], "AES256");
                assert.ok(!objects.has(key)); objects.set(key, await readFile(args[args.indexOf("--body") + 1]));
                if ((failure === "snapshot-ack" && key.endsWith("snapshot.json")) || (failure === "authority-ack" && key.endsWith("authority.json")))
                    throw Error("uncertain write acknowledgement");
                return { stdout: JSON.stringify({ VersionId: failure === "version" ? "null" : "synthetic-v1" }) };
            }
            assert.equal(args[1], "get-object");
            assert.equal(args[args.indexOf("--version-id") + 1], "synthetic-v1");
            await writeFile(args[args.indexOf("--version-id") + 2], failure === "hash" ? Buffer.from("changed") : objects.get(key));
            return { stdout: "{}" };
        };
        const store = await createDevelopmentReleaseStore(env, run);
        await assert.rejects(store.save("arbitrary.json", Buffer.from("{}")));
        const sequence = async () => {
            const snapshot = await store.save("forward-recovery-snapshot.json", Buffer.from("snapshot"));
            assert.equal((await store.read(snapshot)).toString(), "snapshot");
            return store.save("forward-recovery-authority.json", Buffer.from("authority"));
        };
        if (failure) await assert.rejects(sequence());
        else assert.equal((await sequence()).version, "synthetic-v1");
        const writes = calls.filter(args => args[1] === "put-object");
        assert.equal(writes.length, !failure || failure === "authority-ack" ? 2 : 1);
        for (const name of ["snapshot", "authority"])
            assert.ok(writes.filter(args => args.includes(`source/releases/native-456/forward-recovery-${name}.json`)).length <= 1);
    }
});
