import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { installAppSecrets, INVOKER_USER } from "./app-secret-bootstrap.mjs";
const id = "AKIA" + "A".repeat(16);
const key = { UserName: INVOKER_USER, AccessKeyId: id, Status: "Active" };
const saved = { STORY_VIDEO_LAMBDA_ACCESS_KEY_ID: id, STORY_VIDEO_LAMBDA_SECRET_ACCESS_KEY: "s".repeat(40), STORY_VIDEO_GRANT_SECRET: "g".repeat(43) };
function fixture({ recovery, keys = [], failSave = false, status = "Active" } = {}) {
    const calls = [];
    return { calls, dependencies: {
            aws: async (args) => {
                calls.push(args[1]);
                if (args[1] === "get-user")
                    return { User: { Arn: "arn:aws:iam::" + protectedConfig("awsAccountId") + ":user/" + (INVOKER_USER) } };
                if (args[1] === "list-access-keys")
                    return { AccessKeyMetadata: keys };
                if (args[1] === "create-access-key")
                    return { AccessKey: { ...key, Status: status, SecretAccessKey: saved.STORY_VIDEO_LAMBDA_SECRET_ACCESS_KEY } };
                assert.fail("Unexpected AWS operation");
            },
            cf: async (_path, _body, method) => { if (method === "PUT")
                calls.push("install-secret"); return []; },
            load: async () => recovery,
            createRecovery: async (value) => { calls.push("journal"); assert.equal(value.state, "creating"); },
            replaceRecovery: async () => { calls.push("save-key"); if (failSave)
                throw new Error("Disk full"); },
        } };
}
test("bootstrap persists intent before IAM and the key before any Worker secret", async () => {
    const { calls, dependencies } = fixture();
    await installAppSecrets(dependencies);
    assert.deepEqual(calls, ["get-user", "list-access-keys", "journal", "create-access-key", "save-key", "install-secret", "install-secret", "install-secret"]);
});
test("interrupted bootstrap cannot create another key or install partial credentials", async () => {
    for (const options of [{ recovery: { state: "creating" }, keys: [key] }, { keys: [key] }, { failSave: true }]) {
        const { calls, dependencies } = fixture(options);
        await assert.rejects(installAppSecrets(dependencies));
        assert.ok(!calls.includes("install-secret"));
        if (!options.failSave)
            assert.ok(!calls.includes("create-access-key"));
    }
});
test("resume verifies active key identity and never rotates the saved grant secret", async () => {
    const good = fixture({ recovery: saved, keys: [key] });
    await installAppSecrets(good.dependencies);
    assert.ok(!good.calls.includes("create-access-key"));
    assert.equal(good.calls.filter(call => call === "install-secret").length, 3);
    for (const keys of [[], [{ ...key, Status: "Inactive" }], [{ ...key, AccessKeyId: "wrong" }], [key, key]]) {
        const bad = fixture({ recovery: saved, keys });
        await assert.rejects(installAppSecrets(bad.dependencies), /sole active/);
        assert.ok(!bad.calls.includes("install-secret"));
    }
});
