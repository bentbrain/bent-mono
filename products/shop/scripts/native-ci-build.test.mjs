import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { verifyBuildConfiguration, verifyCloudBuild } from "./native-ci-build.mjs";
const buildspec = JSON.stringify({ phases: { build: { commands: ["bash aws-lambda/cloud-build-app.sh"] } }, version: "0.2" });
const environment = { type: "LINUX_CONTAINER", image: "aws/codebuild/standard:7.0", computeType: "BUILD_GENERAL1_SMALL", privilegedMode: true };
test("private source modes are normalized in the image and every app smoke test runs non-root before publication", async () => {
    const base = new URL("../workers/video-renderer/aws-lambda/", import.meta.url);
    const dockerfile = await readFile(new URL("Dockerfile.app", base), "utf8");
    assert.match(dockerfile, /chmod 0644 \/function\/package\.json/);
    for (const mode of ["0755", "0644"])
        assert.ok(dockerfile.includes(`chmod ${mode} {} +`));
    const script = await readFile(new URL("cloud-build-app.sh", base), "utf8");
    const runs = script.split("\n").filter(line => line.startsWith("docker run "));
    assert.equal(runs.length, 4);
    for (const line of runs) {
        assert.ok(line.includes("--user 65532:65532") && line.includes("--read-only") && line.includes("--network none"));
        assert.ok(script.indexOf(line) < script.indexOf('docker push "$repository:$tag"'));
    }
    assert.ok(runs.some(line => line.includes("runtime-smoke.mjs app")));
    assert.ok(runs.some(line => line.includes("runtime-smoke.mjs failure")));
    assert.match(await readFile(new URL("runtime-smoke.mjs", base), "utf8"), /process\.getuid\(\) !== 0/);
});
test("candidate builds reject substituted commands and compute environments", () => {
    const reviewed = { source: { buildspec }, environment };
    verifyBuildConfiguration(reviewed);
    for (const changed of [
        { ...reviewed, source: { buildspec: "version: 0.2" } },
        { ...reviewed, source: { buildspec: buildspec.replace("cloud-build-app.sh", "unreviewed.sh") } },
        { ...reviewed, environment: { ...environment, image: "unreviewed" } },
        { ...reviewed, environment: { ...environment, computeType: "BUILD_GENERAL1_LARGE" } },
    ])
        assert.throws(() => verifyBuildConfiguration(changed));
});
test("candidate verification requires completed exact project, immutable source version and all source hashes", () => {
    const expected = { sourceKey: "source/fixture.zip", sourceVersion: "version-1", sourceDigest: "a".repeat(64), sourceCommit: "b".repeat(40), zipSha256: "c".repeat(64) };
    const id = "forever-tee-video-development:11111111-1111-1111-1111-111111111111";
    const build = { id, arn: "arn:aws:codebuild:ap-southeast-2:" + protectedConfig("awsAccountId") + ":build/" + (id), projectName: "forever-tee-video-development", buildStatus: "SUCCEEDED", buildComplete: true,
        serviceRole: "arn:aws:iam::" + protectedConfig("awsAccountId") + ":role/forever-tee-video-development-build", source: { type: "S3", buildspec, location: "forever-tee-video-development-" + protectedConfig("awsAccountId") + "-ap-southeast-2/source/fixture.zip" },
        sourceVersion: "version-1", environment: { ...environment, environmentVariables: Object.entries({ SOURCE_DIGEST: expected.sourceDigest,
                SOURCE_COMMIT: expected.sourceCommit, SOURCE_ZIP_SHA256: expected.zipSha256, SHOP_AWS_ACCOUNT_ID: protectedConfig("awsAccountId") }).map(([name, value]) => ({ name, value, type: "PLAINTEXT" })) } };
    assert.equal(verifyCloudBuild(build, expected).buildId, id);
    for (const change of [value => { value.buildStatus = "FAILED"; }, value => { value.buildComplete = false; },
        value => { value.projectName = "forever-tee-video-production"; }, value => { value.serviceRole = "work"; },
        value => { value.sourceVersion = "mutable-latest"; }, value => { value.source.location = "other"; },
        value => { value.environment.environmentVariables[0].value = "wrong"; },
        value => { value.environment.environmentVariables.push(value.environment.environmentVariables[0]); }]) {
        const altered = structuredClone(build);
        change(altered);
        assert.throws(() => verifyCloudBuild(altered, expected));
    }
});
