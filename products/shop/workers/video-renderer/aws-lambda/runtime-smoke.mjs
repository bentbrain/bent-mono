import { protectedConfig } from "./protected-config.mjs";
// Cloud image smoke test: real AWS RIC + entry, fake Runtime API, invalid job.
// No rendering, external requests, real credentials or customer artwork.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { BUCKET, FUNCTION_ARN, NAME, REGION } from "./config.mjs";
const failure = process.argv[2] === "failure";
const app = process.argv[2] === "app" || failure;
if (app)
    assert.ok(typeof process.getuid === "function" && process.getuid() !== 0, "App image smoke checks must run as a non-root user.");
const functionName = failure ? "forever-tee-video-development-failures" : app ? "forever-tee-video-development" : NAME;
const functionArn = app ? "arn:aws:lambda:" + (REGION) + ":" + protectedConfig("awsAccountId") + ":function:" + (functionName) : FUNCTION_ARN;
let received = false;
let child;
let complete;
let fail;
let diagnostics = "";
const result = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
const server = createServer(async (request, response) => {
    if (request.url === "/2018-06-01/runtime/invocation/next" && !received) {
        received = true;
        response.writeHead(200, { "content-type": "application/json", "lambda-runtime-aws-request-id": "smoke-request",
            "lambda-runtime-deadline-ms": String(Date.now() + 120000), "lambda-runtime-invoked-function-arn": functionArn });
        response.end(JSON.stringify({ invalid: "benchmark smoke request" }));
        return;
    }
    if (request.url === "/2018-06-01/runtime/invocation/smoke-request/error") {
        const chunks = [];
        for await (const chunk of request)
            chunks.push(chunk);
        try {
            const error = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            assert.match(error.errorMessage, /Invalid (app )?job|Expected the personal failure-queue Lambda/);
            response.writeHead(202).end();
            complete();
        }
        catch (error) {
            response.writeHead(500).end();
            fail(error);
        }
        return;
    }
    if (received && request.url === "/2018-06-01/runtime/invocation/next")
        return;
    response.writeHead(500).end();
    fail(new Error("Unexpected Runtime API call."));
});
const deadline = setTimeout(() => fail(new Error("Runtime API smoke test timed out.")), 20000);
try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    child = spawn("/bin/sh", ["/function/aws-lambda/bootstrap.sh", failure ? "aws-lambda/failure-entry.handler" : app ? "aws-lambda/app-entry.handler" : "aws-lambda/entry.handler"], {
        cwd: "/function", stdio: ["ignore", "pipe", "pipe"], env: {
            PATH: "/usr/local/bin:/usr/bin:/bin", AWS_LAMBDA_RUNTIME_API: `127.0.0.1:${address.port}`,
            AWS_LAMBDA_FUNCTION_NAME: functionName, AWS_LAMBDA_FUNCTION_MEMORY_SIZE: "3008", AWS_REGION: REGION,
            AWS_LAMBDA_FUNCTION_VERSION: "$LATEST", AWS_LAMBDA_LOG_GROUP_NAME: `/aws/lambda/${NAME}`,
            AWS_LAMBDA_LOG_STREAM_NAME: "smoke-only",
            STORY_BUCKET: BUCKET, STORY_BUILD_ID: process.env.STORY_IMAGE_BUILD_ID,
            STORY_API_ORIGIN: "https://forever-tee-api-development.socialqueue.workers.dev",
            STORY_IMAGE_BUILD_ID: process.env.STORY_IMAGE_BUILD_ID,
            AWS_ACCESS_KEY_ID: "smoke-not-a-credential", AWS_SECRET_ACCESS_KEY: "smoke-not-a-credential",
            AWS_SESSION_TOKEN: "smoke-not-a-credential",
        },
    });
    // This process has only fake credentials and an invalid job, with network
    // disabled. Keep bounded diagnostics so a boot failure identifies its cause.
    const capture = (chunk) => { diagnostics = `${diagnostics}${chunk}`.slice(-4096); };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", fail);
    child.once("exit", (code) => fail(new Error(`RIC exited (${code}) before completing the smoke invocation: ${diagnostics}`)));
    await result;
    console.info("RIC loaded the real Lambda entry and rejected an invalid job without rendering or storage.");
}
finally {
    clearTimeout(deadline);
    child?.kill("SIGTERM");
    server.closeAllConnections();
    server.close();
}
