import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { APPROVED_BOOTSTRAP, BOOTSTRAP_PRIVATE, bootstrapArguments } from "./aws-personal-bootstrap.mjs";
import { checkBootstrapVacancies, executeBootstrapOnce, privateWrite } from "./aws-personal-bootstrap-apply.mjs";
import { validatePersonalArguments } from "./aws-personal-guard.mjs";
test("bootstrap apply is pinned to the reviewed ID and hash, with no general apply or overrides", () => {
    const args = ["apply", `--review=${APPROVED_BOOTSTRAP.review}`, `--plan-sha256=${APPROVED_BOOTSTRAP.planSha256}`];
    assert.equal(bootstrapArguments(args).operation, "apply");
    for (const changed of [["apply"], [...args, "-auto-approve"], [args[0], "--review=review-ABC123", args[2]],
        [args[0], args[1], `--plan-sha256=${"a".repeat(64)}`], [...args, "-target=aws_iam_role.ci"],
        [...args, "--environment=production"], [...args, "-state=other.tfstate"]])
        assert.throws(() => bootstrapArguments(changed));
});
test("KMS reads cannot change aliases, select another key or inject CLI options", () => {
    const args = ["kms", "describe-key", "--key-id", "alias/forever-tee-video-development-state"];
    validatePersonalArguments(args);
    for (const changed of [[...args, "--cli-input-json", "{}"], ["kms", "list-keys"],
        ["kms", "describe-key", "--key-id", "alias/work"], ["kms", "create-key"], [...args, "--profile=work"]]) {
        assert.throws(() => validatePersonalArguments(changed));
    }
});
function absent(args) {
    const operations = { "get-role": ["NoSuchEntity", "GetRole"], "get-policy": ["NoSuchEntity", "GetPolicy"],
        "describe-key": ["NotFoundException", "DescribeKey"], "head-bucket": ["404", "HeadBucket"] };
    const [code, operation] = operations[args[1]];
    return Object.assign(new Error("fixture"), { stderr: `An error occurred (${code}) when calling the ${operation} operation: Not found` });
}
const provider = { Url: "token.actions.githubusercontent.com", ClientIDList: ["sts.amazonaws.com"] };
test("collision checks require exact absence responses and a valid existing OIDC provider", async () => {
    const calls = [];
    await checkBootstrapVacancies(async (args) => {
        validatePersonalArguments(args);
        calls.push(args);
        if (args[1] === "get-open-id-connect-provider")
            return JSON.stringify(provider);
        throw absent(args);
    });
    assert.equal(calls.length, 5);
    assert.ok(calls.some(args => args[1] === "head-bucket" && args.includes("--expected-bucket-owner") && args.includes(protectedConfig("awsAccountId"))));
    await assert.rejects(checkBootstrapVacancies(async (args) => {
        if (args[1] === "get-open-id-connect-provider")
            return JSON.stringify({ ...provider, ClientIDList: [] });
        throw absent(args);
    }), /no longer matches/);
});
test("existing resources, wrong-service errors, expired SSO, 403 and network failures stop before apply", async () => {
    for (let target = 0; target < 4; target++) {
        for (const response of [null, new Error("SSO expired"), Object.assign(new Error(), { stderr: "network timeout" }),
            Object.assign(new Error(), { stderr: "An error occurred (403) when calling the HeadBucket operation: Forbidden" }),
            Object.assign(new Error(), { stderr: "An error occurred (NoSuchEntity) when calling the GetUser operation: Missing" })]) {
            let calls = 0;
            await assert.rejects(checkBootstrapVacancies(async (args) => {
                if (calls++ !== target)
                    throw absent(args);
                if (response)
                    throw response;
                return "{}";
            }), /already exists|collision check failed/);
            assert.equal(calls, target + 1);
        }
    }
});
test("apply order durably records intent and preserves backups before the only mutation", async () => {
    const order = [];
    const operations = Object.fromEntries(["inspect", "vacancies", "backup", "startJournal", "recheck", "apply", "finishJournal"]
        .map(name => [name, async () => { order.push(name); return name === "backup" ? ["saved"] : undefined; }]));
    await executeBootstrapOnce(operations);
    assert.deepEqual(order, ["inspect", "vacancies", "backup", "startJournal", "recheck", "apply", "finishJournal"]);
    for (const failure of ["inspect", "vacancies", "backup", "startJournal", "recheck", "apply"]) {
        order.length = 0;
        await assert.rejects(executeBootstrapOnce({ ...operations, [failure]: async () => { order.push(failure); throw new Error("stop"); } }), /stop/);
        assert.equal(order.includes("finishJournal"), false);
        assert.equal(order.filter(value => value === "apply").length, failure === "apply" ? 1 : 0);
    }
});
test("private journal writes sync to disk, reject a second owner and never overwrite content", async () => {
    await mkdir(BOOTSTRAP_PRIVATE, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(BOOTSTRAP_PRIVATE, "test-journal-"));
    try {
        const path = join(directory, "intent.json");
        await privateWrite(path, "original");
        await assert.rejects(privateWrite(path, "replacement"), { code: "EEXIST" });
        assert.equal(await readFile(path, "utf8"), "original");
        assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
    finally {
        await rm(directory, { recursive: true });
    }
});

test("OIDC audience must be an array containing the exact STS audience", async () => {
    for (const ClientIDList of ["prefix-sts.amazonaws.com-suffix", "sts.amazonaws.com", ["prefix-sts.amazonaws.com-suffix"]]) {
        const call = async args => {
            if (args[1] === "get-open-id-connect-provider") return JSON.stringify({ ...provider, ClientIDList });
            throw absent(args);
        };
        await assert.rejects(checkBootstrapVacancies(call), /issuer\/audience/);
    }
});
