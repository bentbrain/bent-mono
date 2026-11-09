import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const smoke = fileURLToPath(new URL("runtime-smoke.mjs", import.meta.url));

async function runSmoke(t, mode, scenario = "invoke") {
    const directory = await mkdtemp(join(tmpdir(), "runtime-smoke-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    // Replace only the image-specific executable/location. The CLI constructs
    // its real environment and Runtime API, then spawns a separate Node process
    // that imports the actual entry. The hosted image still qualifies real RIC.
    const probe = `
        import assert from "node:assert/strict";
        const api = "http://" + process.env.AWS_LAMBDA_RUNTIME_API + "/2018-06-01/runtime/";
        let entry;
        try {
            entry = await import(new URL(process.argv[1].replace(/\\.handler$/, ".mjs"), ${JSON.stringify(new URL("../", import.meta.url).href)}));
            assert.deepEqual(JSON.parse(process.env.SHOP_PROTECTED_CONFIG_JSON), { awsAccountId: "000000000000" });
            for (const key of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"])
                assert.equal(process.env[key], "smoke-not-a-credential");
            for (const key of ["SMOKE_PARENT_SECRET", "AWS_PROFILE", "HOME"])
                assert.equal(process.env[key], undefined);
            assert.equal(process.env.STORY_BUILD_ID, "a".repeat(64));
            assert.equal(process.env.STORY_BUILD_ID, process.env.STORY_IMAGE_BUILD_ID);
            if (${JSON.stringify(scenario)} === "init-error") throw new Error("Synthetic initialization failure.");
        } catch (error) {
            console.error("Probe initialization failed:", error.message);
            await fetch(api + "init/error", { method: "POST", body: JSON.stringify({ errorType: error.name, errorMessage: error.message }) });
            process.exit(1);
        }
        const response = await fetch(api + "invocation/next");
        const event = await response.json();
        const context = {
            invokedFunctionArn: response.headers.get("lambda-runtime-invoked-function-arn"),
            awsRequestId: response.headers.get("lambda-runtime-aws-request-id"),
            getRemainingTimeInMillis: () => Number(response.headers.get("lambda-runtime-deadline-ms")) - Date.now(),
        };
        let error;
        try { await entry.handler(event, context); }
        catch (caught) { error = caught; }
        if (${JSON.stringify(scenario)} === "wrong-error") error = new Error("Synthetic unrelated invocation failure.");
        const path = "invocation/" + context.awsRequestId + (error ? "/error" : "/response");
        await fetch(api + path, { method: "POST", body: JSON.stringify(error ? { errorMessage: error.message } : {}) });
        await new Promise(() => {});
    `;
    const preload = join(directory, "preload.mjs");
    await writeFile(preload, `
        import assert from "node:assert/strict";
        import childProcess from "node:child_process";
        import { syncBuiltinESMExports } from "node:module";
        const spawn = childProcess.spawn;
        childProcess.spawn = (command, args, options) => {
            assert.equal(command, "/bin/sh");
            assert.equal(args[0], "/function/aws-lambda/bootstrap.sh");
            assert.equal(options.cwd, "/function");
            return spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(probe)}, args[1]], { ...options, cwd: ${JSON.stringify(directory)} });
        };
        syncBuiltinESMExports();
    `);
    return exec(process.execPath, ["--import", preload, smoke, ...(mode ? [mode] : [])], {
        timeout: 10000,
        env: {
            PATH: "/usr/bin:/bin",
            SHOP_PROTECTED_CONFIG_JSON: JSON.stringify({ awsAccountId: "000000000000", unrelatedSecret: "parent-only" }),
            STORY_IMAGE_BUILD_ID: "a".repeat(64),
            AWS_ACCESS_KEY_ID: "parent-access-key",
            AWS_SECRET_ACCESS_KEY: "parent-secret-key",
            AWS_SESSION_TOKEN: "parent-session-token",
            AWS_PROFILE: "parent-profile",
            SMOKE_PARENT_SECRET: "parent-only",
            HOME: directory,
        },
    });
}

for (const mode of ["app", "failure", ""]) {
    test(`${mode || "benchmark"} smoke initializes its child with isolated account configuration and rejects the invalid job`, async (t) => {
        const { stdout } = await runSmoke(t, mode);
        assert.match(stdout, /RIC loaded the real Lambda entry and rejected an invalid job/);
    });
}

test("smoke rejects unrelated invocation errors", async (t) => {
    await assert.rejects(runSmoke(t, "app", "wrong-error"), (error) => {
        assert.match(error.stderr, /Synthetic unrelated invocation failure/);
        assert.doesNotMatch(error.stdout, /RIC loaded/);
        return true;
    });
});

test("smoke reports initialization errors and fails before invoking the handler", async (t) => {
    await assert.rejects(runSmoke(t, "app", "init-error"), (error) => {
        assert.match(error.stderr, /RIC initialization failed:.*Synthetic initialization failure/);
        assert.doesNotMatch(error.stdout, /RIC loaded/);
        return true;
    });
});
