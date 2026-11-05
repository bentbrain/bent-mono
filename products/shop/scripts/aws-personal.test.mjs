import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { personalSsoRoles } from "./aws-personal-sso.mjs";
import { createHash } from "node:crypto";
import { guardedPersonalCall, PERSONAL_ACCOUNT, PERSONAL_CONFIG_PATH, personalEnvironment, validatePersonalArguments, validatePersonalConfig, } from "./aws-personal-guard.mjs";
const config = "[profile personal-dev]\nsso_session = personal-dev\nsso_account_id = " + protectedConfig("awsAccountId") + "\nsso_role_name = AdministratorAccess\nregion = ap-southeast-2\n\n[sso-session personal-dev]\nsso_start_url = " + protectedConfig("ssoStartUrl") + "\nsso_region = ap-southeast-2\nsso_registration_scopes = sso:account:access\n";
const identity = { Account: PERSONAL_ACCOUNT, Arn: `arn:aws:sts::${PERSONAL_ACCOUNT}:assumed-role/AWSReservedSSO_AdministratorAccess_example/session` };
test("discards inherited work credentials, config, endpoint and process injection", () => {
    const env = personalEnvironment({
        HOME: "/Users/example", AWS_PROFILE: "work", AWS_DEFAULT_PROFILE: "work",
        AWS_ACCESS_KEY_ID: "forbidden", AWS_SECRET_ACCESS_KEY: "forbidden", AWS_SESSION_TOKEN: "forbidden",
        AWS_CONFIG_FILE: "/work/config", AWS_SHARED_CREDENTIALS_FILE: "/work/credentials",
        AWS_CONTAINER_CREDENTIALS_FULL_URI: "https://work.invalid", AWS_WEB_IDENTITY_TOKEN_FILE: "/work/token",
        AWS_ENDPOINT_URL: "https://work.invalid", AWS_DATA_PATH: "/work/models",
        PYTHONPATH: "/work/python", HTTPS_PROXY: "https://work.invalid",
    });
    assert.equal(env.AWS_PROFILE, "personal-dev");
    assert.equal(env.AWS_CONFIG_FILE, PERSONAL_CONFIG_PATH);
    assert.equal(env.AWS_SHARED_CREDENTIALS_FILE, "/dev/null");
    assert.equal(env.AWS_EC2_METADATA_DISABLED, "true");
    assert.equal(JSON.stringify(env).includes("forbidden"), false);
    for (const name of ["AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ENDPOINT_URL", "AWS_DATA_PATH", "PYTHONPATH", "HTTPS_PROXY"]) {
        assert.equal(env[name], undefined);
    }
    assert.equal(env.HOME, "/Users/example");
});
test("rejects default profiles, credential processes, chains and additional sessions before AWS", () => {
    validatePersonalConfig(config);
    for (const extra of ["[default]", "credential_process = work-helper", "source_profile = work", "[sso-session work]"]) {
        assert.throws(() => validatePersonalConfig(`${config}\n${extra}`));
    }
    assert.throws(() => validatePersonalConfig(config.replace(PERSONAL_ACCOUNT, "111111111111")));
});
test("rejects command-line credential overrides, abbreviations and role switching", () => {
    for (const flag of ["--profile=work", "--prof", "--region", "--endpoint", "--no-sign-request", "--debug"]) {
        assert.throws(() => validatePersonalArguments(["lambda", "get-account-settings", flag]));
    }
    assert.throws(() => validatePersonalArguments(["sts", "assume-role"]));
    assert.throws(() => validatePersonalArguments(["configure", "export-credentials"]));
    assert.throws(() => validatePersonalArguments(["lambda", "get-function", "--function-name", "arn:aws:lambda:ap-southeast-2:111111111111:function:work"]));
});
test("validates personal identity before the requested operation", async () => {
    const calls = [];
    await guardedPersonalCall(["lambda", "get-account-settings"], {
        config, environment: {}, execute: async (args, env) => {
            calls.push(args.slice(0, 2));
            assert.equal(env.AWS_SHARED_CREDENTIALS_FILE, "/dev/null");
            return JSON.stringify(identity);
        },
    });
    assert.deepEqual(calls, [["sts", "get-caller-identity"], ["lambda", "get-account-settings"]]);
});
test("IAM service-key operations cannot target other users or override inputs", () => {
    for (const operation of ["get-user", "list-access-keys", "create-access-key"]) {
        validatePersonalArguments(["iam", operation, "--user-name", "forever-tee-video-development-invoker"]);
        assert.throws(() => validatePersonalArguments(["iam", operation, "--user-name", "work"]));
        assert.throws(() => validatePersonalArguments(["iam", operation]));
        assert.throws(() => validatePersonalArguments(["iam", operation, "--user-name", "forever-tee-video-development-invoker", "--cli-input-json", "{}"]));
    }
});
test("bootstrap IAM discovery is read-only and limited to exact personal targets", () => {
    const operations = [
        ["get-open-id-connect-provider", "--open-id-connect-provider-arn", `arn:aws:iam::${PERSONAL_ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`],
        ["get-role", "--role-name", "forever-tee-video-development-ci"],
        ["get-policy", "--policy-arn", `arn:aws:iam::${PERSONAL_ACCOUNT}:policy/forever-tee-video-development-ci-boundary`],
    ];
    for (const operation of operations) {
        validatePersonalArguments(["iam", ...operation]);
        assert.throws(() => validatePersonalArguments(["iam", ...operation, "--cli-input-json", "{}"]));
        assert.throws(() => validatePersonalArguments(["iam", ...operation.slice(0, 2), "foreign"]));
    }
    for (const operation of ["create-role", "put-role-policy", "update-assume-role-policy", "delete-role"]) {
        assert.throws(() => validatePersonalArguments(["iam", operation, "--role-name", "forever-tee-video-development-ci"]));
    }
});
test("mismatched identity or expired personal SSO never falls back or executes the operation", async () => {
    for (const wrong of [true, false]) {
        let calls = 0;
        await assert.rejects(guardedPersonalCall(["lambda", "get-account-settings"], {
            config, environment: { AWS_PROFILE: "work" }, execute: async () => {
                calls += 1;
                if (!wrong)
                    throw new Error("Personal SSO expired");
                return JSON.stringify({ ...identity, Account: "111111111111" });
            },
        }));
        assert.equal(calls, 1);
    }
});
test("invalid isolated configuration makes zero AWS calls", async () => {
    let calls = 0;
    await assert.rejects(guardedPersonalCall(["sts", "get-caller-identity"], {
        config: "[default]", environment: {}, execute: async () => { calls += 1; return "{}"; },
    }));
    assert.equal(calls, 0);
});
test("support diagnostics retain personal isolation and do not authorize support writes", async () => {
    const calls = [];
    await guardedPersonalCall(["support", "describe-cases", "--display-id", "178788072600019", "--include-resolved-cases", "--no-include-communications"], {
        config, environment: { AWS_PROFILE: "work" }, execute: async (args, env) => {
            calls.push(args.slice(0, 2));
            assert.equal(env.AWS_PROFILE, "personal-dev");
            assert.equal(env.AWS_SHARED_CREDENTIALS_FILE, "/dev/null");
            return JSON.stringify(identity);
        },
    });
    assert.deepEqual(calls, [["sts", "get-caller-identity"], ["support", "describe-cases"]]);
    assert.throws(() => validatePersonalArguments(["support", "create-case"]));
    assert.throws(() => validatePersonalArguments(["support", "add-communication-to-case"]));
    assert.throws(() => validatePersonalArguments(["support", "describe-cases", "--profile", "work"]));
});
test("quota writes allow only the approved Lambda concurrency increase", () => {
    const args = ["service-quotas", "request-service-quota-increase",
        "--service-code", "lambda", "--quota-code", "L-B99A9384", "--desired-value", "1000"];
    validatePersonalArguments(args);
    for (const changed of [
        args.map((value) => value === "1000" ? "10000" : value),
        args.map((value) => value === "lambda" ? "ec2" : value),
        args.map((value) => value === "L-B99A9384" ? "L-OTHER" : value),
        [...args, "--desired-value", "10000"],
        [...args, "--cli-input-json", "file://override.json"],
        [...args, "--profile", "work"],
    ]) {
        assert.throws(() => validatePersonalArguments(changed), /owner-approved/);
    }
});
test("quota increases verify personal identity before submission", async () => {
    const args = ["service-quotas", "request-service-quota-increase",
        "--service-code", "lambda", "--quota-code", "L-B99A9384", "--desired-value", "1000"];
    const calls = [];
    await guardedPersonalCall(args, {
        config, environment: { AWS_PROFILE: "work", AWS_ACCESS_KEY_ID: "forbidden" },
        execute: async (actual, env) => {
            calls.push(actual.slice(0, 2));
            assert.equal(env.AWS_PROFILE, "personal-dev");
            assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
            return JSON.stringify(identity);
        },
    });
    assert.deepEqual(calls, [["sts", "get-caller-identity"], ["service-quotas", "request-service-quota-increase"]]);
    let deniedCalls = 0;
    await assert.rejects(guardedPersonalCall(args, {
        config, environment: {}, execute: async () => {
            deniedCalls += 1;
            return JSON.stringify({ ...identity, Account: "111111111111" });
        },
    }));
    assert.equal(deniedCalls, 1);
});
test("SSO role discovery reads one approved cache and requests only the personal account", async () => {
    let reads = 0;
    const result = await personalSsoRoles({ HOME: "/Users/example" }, {
        now: 1000,
        read: async (path) => {
            reads += 1;
            assert.equal(path, `/Users/example/.aws/sso/cache/${createHash("sha1").update("personal-dev").digest("hex")}.json`);
            return JSON.stringify({ startUrl: protectedConfig("ssoStartUrl"), region: "ap-southeast-2", expiresAt: "2099-01-01T00:00:00Z", accessToken: "personal-fixture-token" });
        },
        request: async (url, init) => {
            assert.equal(url.origin, "https://portal.sso.ap-southeast-2.amazonaws.com");
            assert.equal(url.searchParams.get("account_id"), PERSONAL_ACCOUNT);
            assert.equal(init.redirect, "error");
            return Response.json({ roleList: [{ accountId: PERSONAL_ACCOUNT, roleName: "AdministratorAccess" }] });
        },
    });
    assert.equal(reads, 1);
    assert.equal(result.includes("personal-fixture-token"), false);
    assert.deepEqual(JSON.parse(result).roles, ["AdministratorAccess"]);
});
test("SSO lookup rejects another portal's token and accepts no caller account override", async () => {
    let calls = 0;
    await assert.rejects(personalSsoRoles({ HOME: "/Users/example" }, {
        read: async () => JSON.stringify({ startUrl: "https://work.invalid", accessToken: "forbidden" }),
        request: async () => { calls += 1; return Response.json({}); },
    }));
    assert.equal(calls, 0);
    assert.throws(() => validatePersonalArguments(["sso", "list-account-roles", "--account-id", "111111111111"]));
    assert.throws(() => validatePersonalArguments(["sso", "login", "--sso-session", "work"]));
});
