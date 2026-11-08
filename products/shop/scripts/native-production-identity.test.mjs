import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inspectProductionIdentity, verifyProductionToken, PRODUCTION_SUBJECT } from "./native-production-identity.mjs";
const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "bentbrain/bent-mono", GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"),
    GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"), GITHUB_REF: "refs/heads/main", GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "123",
    GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ATTEMPT: "1", GITHUB_WORKFLOW_REF: "bentbrain/bent-mono/.github/workflows/native-production-identity.yml@refs/heads/main" };
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keys = [{ ...pair.publicKey.export({ format: "jwk" }), kid: "fixture", use: "sig" }];
const claims = { iss: "https://token.actions.githubusercontent.com", aud: "sts.amazonaws.com", sub: PRODUCTION_SUBJECT,
    repository: env.GITHUB_REPOSITORY, repository_id: env.GITHUB_REPOSITORY_ID, repository_owner: "bentbrain", repository_owner_id: env.GITHUB_REPOSITORY_OWNER_ID,
    environment: "Production", ref: env.GITHUB_REF, sha: env.GITHUB_SHA, run_id: env.GITHUB_RUN_ID, run_attempt: "1", event_name: env.GITHUB_EVENT_NAME,
    workflow_ref: env.GITHUB_WORKFLOW_REF, iat: 1000, nbf: 1000, exp: 1300 };
function token(value = claims) {
    const body = [JSON.stringify({ alg: "RS256", kid: "fixture" }), JSON.stringify(value)].map(value => Buffer.from(value).toString("base64url")).join(".");
    return `${body}.${sign("RSA-SHA256", Buffer.from(body), pair.privateKey).toString("base64url")}`;
}
test("Production identity is main-only, exact-subject and first manual attempt", () => {
    const jwt = token({ ...claims, ignoredSecret: "never-log-this" }), result = verifyProductionToken(jwt, keys, env, 1100);
    assert.equal(result.subject, PRODUCTION_SUBJECT);
    assert.equal(result.deploymentAttempted, false);
    assert.equal(JSON.stringify(result).includes("never-log-this"), false);
    assert.equal(JSON.stringify(result).includes(jwt), false);
    for (const delta of [{ ref: "refs/heads/perf/story-video-family-experiments" }, { environment: "Preview" }, { sub: PRODUCTION_SUBJECT.replace("Production", "Preview") },
        { repository_id: "work" }, { repository_owner_id: "work" }, { run_attempt: "2" }, { event_name: "push" }, { exp: 1001 }, { sha: "b".repeat(40) },
        { workflow_ref: "foreign" }, { aud: "foreign" }])
        assert.throws(() => verifyProductionToken(token({ ...claims, ...delta }), keys, env, 1100));
    for (const delta of [{ GITHUB_REF: "refs/heads/perf/story-video-family-experiments" }, { GITHUB_RUN_ATTEMPT: "2" }, { GITHUB_EVENT_NAME: "push" },
        { GITHUB_WORKFLOW_REF: "foreign" }])
        assert.throws(() => verifyProductionToken(token(), keys, { ...env, ...delta }, 1100));
});
test("Production identity rejects invalid signatures and local or foreign endpoint requests", async () => {
    assert.throws(() => verifyProductionToken(token().slice(0, -20) + "bad", keys, env, 1100));
    const noNetwork = () => assert.fail("No request permitted");
    await assert.rejects(inspectProductionIdentity({}, noNetwork));
    await assert.rejects(inspectProductionIdentity({ ...env, ACTIONS_ID_TOKEN_REQUEST_URL: "https://evil.test", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "secret" }, noNetwork));
});

test("Production workflow preserves the signed receipt and masks private inspections", () => {
    const marker = "synthetic-inspection-marker";
    const maskOutput = execFileSync(process.execPath, [fileURLToPath(new URL("./mask-release-config.mjs", import.meta.url))], {
        encoding: "utf8",
        env: { SHOP_PROTECTED_CONFIG_JSON: JSON.stringify({ githubRepositoryId: env.GITHUB_REPOSITORY_ID,
            githubOwnerId: env.GITHUB_REPOSITORY_OWNER_ID, stage: "production", privateMarker: marker }) },
    });
    const masks = maskOutput.trim().split("\n").map(line => {
        assert.ok(line.startsWith("::add-mask::"));
        return line.slice("::add-mask::".length).replaceAll("%0A", "\n").replaceAll("%0D", "\r").replaceAll("%25", "%");
    });
    assert.ok(masks.includes("production") && masks.includes(marker));
    const isMask = step => step.includes("run: node scripts/mask-release-config.mjs");
    function exercise(steps) {
        let masked = false, proofs = 0, inspections = 0;
        const output = value => masked ? masks.reduce((text, mask) => text.replaceAll(mask, "***"), value) : value;
        for (const step of steps) {
            if (isMask(step)) { masked = true; continue; }
            if (step.includes("run: node scripts/native-production-identity.mjs")) {
                const receipt = JSON.parse(output(JSON.stringify(verifyProductionToken(token(), keys, env, 1100))));
                assert.equal(receipt.workflowRef, env.GITHUB_WORKFLOW_REF, "signed receipt must retain its exact workflow reference");
                proofs++;
            } else if ((step.includes("scripts/native-production-inspection.mjs") || step.includes("scripts/native-production-storefront.mjs")) && !step.includes("--test")) {
                assert.ok(masked, "private inspections require protected masking");
                assert.equal(output(marker), "***");
                inspections++;
            } else if (!masked && step.includes("run:")) {
                assert.ok(step.includes("node ../../scripts/require-release-checks.mjs") ||
                    step.includes("run: node --import ./scripts/test-protected-config.mjs --test"), "only public admission and synthetic tests precede masking");
            }
        }
        assert.equal(proofs, 1);
        assert.equal(inspections, 2);
    }
    for (const path of ["../.github/workflows/native-production-identity.yml", "../../../.github/workflows/native-production-identity.yml"]) {
        const steps = readFileSync(new URL(path, import.meta.url), "utf8").split(/^      - /m).slice(1);
        exercise(steps);
        const unmasked = steps.filter(step => !isMask(step));
        assert.throws(() => exercise(unmasked), /private inspections require protected masking/);
        assert.throws(() => exercise([steps.find(isMask), ...unmasked]), /signed receipt must retain its exact workflow reference/);
    }
});
