import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { verifyDevelopmentRuntimeFunction } from "./native-ci-runtime.mjs";
function fixture(failure = false) {
    const name = `forever-tee-video-development${failure ? "-failures" : ""}`;
    const imageUri = protectedConfig("awsAccountId") + ".dkr.ecr.ap-southeast-2.amazonaws.com/forever-tee-video-development@sha256:" + ("a".repeat(64));
    return { Code: { ImageUri: imageUri, ResolvedImageUri: imageUri }, Configuration: {
            FunctionName: name, FunctionArn: "arn:aws:lambda:ap-southeast-2:" + protectedConfig("awsAccountId") + ":function:" + (name), PackageType: "Image",
            State: "Active", LastUpdateStatus: "Successful", Architectures: ["x86_64"], MemorySize: failure ? 128 : 3008, Timeout: failure ? 30 : 120,
            Role: "arn:aws:iam::" + protectedConfig("awsAccountId") + ":role/forever-tee-video-development-" + (failure ? "failures" : "runtime"),
            Environment: { Variables: { STORY_API_ORIGIN: "https://forever-tee-api-development.socialqueue.workers.dev", STORY_BUILD_ID: "b".repeat(64) } },
            EphemeralStorage: { Size: 1024 }, ImageConfigResponse: { ImageConfig: { Command: failure ? ["aws-lambda/failure-entry.handler"] : [] } },
        } };
}
test("runtime preflight accepts only the active immutable Development pair and reviewed capacity", () => {
    assert.equal(verifyDevelopmentRuntimeFunction(fixture()).memoryMB, 3008);
    assert.equal(verifyDevelopmentRuntimeFunction(fixture(true), true).memoryMB, 128);
    for (const change of [value => { value.Configuration.State = "Failed"; }, value => { value.Configuration.MemorySize = 10000; },
        value => { value.Configuration.Timeout = 900; }, value => { value.Configuration.Role = "work"; },
        value => { value.Configuration.FunctionArn = "production"; }, value => { value.Code.ImageUri = "mutable:latest"; },
        value => { value.Configuration.Environment.Variables.STORY_DEPLOYMENT_ENV = "production"; },
        value => { value.Configuration.Environment.Variables.STORY_API_ORIGIN = "https://other.example"; },
        value => { value.Configuration.Environment.Variables.STORY_BUILD_ID = "unverified"; }]) {
        const value = fixture();
        change(value);
        assert.throws(() => verifyDevelopmentRuntimeFunction(value));
    }
    const failure = fixture(true);
    failure.Configuration.ImageConfigResponse.ImageConfig.Command = ["wrong"];
    assert.throws(() => verifyDevelopmentRuntimeFunction(failure, true));
});
