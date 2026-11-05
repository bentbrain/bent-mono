import { protectedConfig } from "./protected-config.mjs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";
import { createDevelopmentCICall } from "./native-ci-aws.mjs";
import { assertReleasePaused, inspectDevelopmentDrain } from "./native-release-pause.mjs";
import { verifyDevelopmentObservations } from "./native-ci-observations.mjs";
import { assertDeployableImage } from "./native-ci-image-policy.mjs";
const execute = promisify(execFile);
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MODULE = join(ROOT, "infra/story-video-lambda");
const NAME = "forever-tee-video-development";
const IMAGE = protectedConfig("awsAccountId") + ".dkr.ecr.ap-southeast-2.amazonaws.com/" + (NAME);
const ORIGIN = "https://forever-tee-api-development.socialqueue.workers.dev";
const ZIP_HASH = protectedConfig("resource_9519c9b3fa59");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const check = (value, reason) => { if (!value)
    throw new Error(`Native Terraform review failed: ${reason}`); };
export const DEVELOPMENT_RESOURCES = [
    "aws_sqs_queue.failure_dead_letter", "aws_sqs_queue.failures", "aws_iam_role_policy.failure_destination",
    "aws_lambda_function_event_invoke_config.renderer[0]", "aws_cloudwatch_log_group.failure", "aws_iam_role.failure",
    "aws_iam_role_policy.failure", "aws_lambda_function.failure[0]", "aws_lambda_event_source_mapping.failures[0]",
    "aws_ecr_repository.renderer", "aws_s3_bucket.source", "aws_s3_bucket_public_access_block.source",
    "aws_s3_bucket_server_side_encryption_configuration.source", "aws_s3_bucket_versioning.source", "aws_s3_bucket_policy.source_tls",
    "aws_cloudwatch_log_group.lambda", "aws_cloudwatch_log_group.build", "aws_iam_role.runtime", "aws_iam_role_policy.runtime",
    "aws_iam_role.build", "aws_iam_role_policy.build", "aws_codebuild_project.renderer", "aws_lambda_function.renderer[0]",
    "aws_iam_user.invoker", "aws_iam_user_policy.invoke",
];
const containsUnknown = value => value === true || (value !== null && typeof value === "object" && Object.values(value).some(containsUnknown));
export function terraformFailureSummary(error) {
    const output = [error.stdout, error.stderr].filter(value => typeof value === "string").join("\n");
    return {
        deniedActions: [...new Set([...output.matchAll(/not authorized to perform:\s*([a-z0-9]+:[A-Za-z0-9]+)/gi)].map(match => match[1]))],
        operations: [...new Set([...output.matchAll(/operation error ([A-Za-z0-9]+): ([A-Za-z0-9]+)[,:]/g)].map(match => `${match[1]}:${match[2]}`))],
        serviceErrors: [...new Set([...output.matchAll(/api error ([A-Za-z0-9]+):/g)].map(match => match[1]))],
        categories: ["Error acquiring the state lock", "Failed to get existing workspaces", "Failed to load state", "Unsupported argument",
            "Reference to undeclared", "Failed to load plugin schemas", "Invalid provider configuration", "Error configuring S3 Backend",
            "No valid credential sources found", "Failed to get shared config profile", "No stored credentials were found"].filter(value => output.includes(value)),
        exitCode: typeof error.code === "number" ? error.code : null,
        timedOut: error.killed === true,
    };
}
export function inspectDevelopmentImagePlan(plan, candidate, recoveryCandidates) {
    assertDeployableImage(candidate?.imageDigest);
    check(candidate.environment === "development" && candidate.accountId === protectedConfig("awsAccountId") && candidate.region === "ap-southeast-2" &&
        /^sha256:[a-f0-9]{64}$/.test(candidate.imageDigest) && /^[a-f0-9]{64}$/.test(candidate.sourceDigest) &&
        candidate.imageUri === `${IMAGE}@${candidate.imageDigest}`, "candidate identity.");
    check(plan.terraform_version === "1.12.2" && plan.complete === true && plan.errored === false &&
        !plan.deferred_changes?.length, "incomplete or failed plan.");
    let observationsPlan = plan;
    const imageObservations = [];
    if (recoveryCandidates !== undefined) {
        check(Array.isArray(recoveryCandidates) && recoveryCandidates.length === 2 && recoveryCandidates.some(item => item.imageUri === candidate.imageUri && item.sourceDigest === candidate.sourceDigest), "rollback candidate pair.");
        for (const item of recoveryCandidates)
            check(item.environment === "development" && item.accountId === protectedConfig("awsAccountId") &&
                item.region === "ap-southeast-2" && /^sha256:[a-f0-9]{64}$/.test(item.imageDigest) && /^[a-f0-9]{64}$/.test(item.sourceDigest) &&
                item.imageUri === `${IMAGE}@${item.imageDigest}`, "rollback candidate identity.");
        observationsPlan = { ...plan, resource_drift: [] };
        for (const drift of plan.resource_drift ?? []) {
            if (!["aws_lambda_function.renderer[0]", "aws_lambda_function.failure[0]"].includes(drift.address)) {
                observationsPlan.resource_drift.push(drift);
                continue;
            }
            check(drift.mode === "managed" && drift.provider_name === "registry.terraform.io/hashicorp/aws" &&
                isDeepStrictEqual(drift.change.actions, ["update"]) && !drift.previous_address && !drift.change.importing, "rollback function observation.");
            const { before, after } = drift.change;
            const changedFields = Object.keys(after).filter(key => !isDeepStrictEqual(before[key], after[key]));
            if (changedFields.every(key => ["tags", "layers", "image_config"].includes(key))) {
                observationsPlan.resource_drift.push(drift);
                continue;
            }
            const restored = { ...after };
            for (const value of [before, after]) {
                const match = recoveryCandidates.find(item => item.imageUri === value.image_uri);
                check(match && isDeepStrictEqual(value.environment, [{ variables: { STORY_API_ORIGIN: ORIGIN,
                            ...(drift.address === "aws_lambda_function.renderer[0]" ? { STORY_BUILD_ID: match.sourceDigest } : {}) } }]), "rollback observed source/image pair.");
            }
            for (const key of ["image_uri", "environment", "last_modified", "source_code_hash", "source_code_size", "version", "qualified_arn", "qualified_invoke_arn"]) {
                if (Object.hasOwn(before, key))
                    restored[key] = before[key];
                else
                    delete restored[key];
            }
            check(isDeepStrictEqual(restored, before) && isDeepStrictEqual(plan.resource_changes.find(item => item.address === drift.address)?.change.before, after), "rollback observation contains non-image changes.");
            imageObservations.push({ address: drift.address, recordedPairImageObservation: true });
        }
    }
    const observations = [...verifyDevelopmentObservations(observationsPlan), ...imageObservations];
    const addresses = { "aws_lambda_function.renderer[0]": NAME, "aws_lambda_function.failure[0]": `${NAME}-failures` };
    const seen = new Set();
    const updated = [];
    for (const item of plan.resource_changes ?? []) {
        check(item.mode === "managed" && item.provider_name === "registry.terraform.io/hashicorp/aws" &&
            DEVELOPMENT_RESOURCES.includes(item.address) && !seen.has(item.address) && !item.previous_address && !item.change.importing, "unexpected, moved, imported or duplicate resource/provider.");
        seen.add(item.address);
        const { actions, before, after, after_unknown: unknown = {} } = item.change;
        const unchanged = isDeepStrictEqual(actions, ["no-op"]);
        if (!Object.hasOwn(addresses, item.address)) {
            check(unchanged, `only existing renderer/failure image updates are permitted (${item.address}).`);
            continue;
        }
        check(unchanged || isDeepStrictEqual(actions, ["update"]), `only existing renderer/failure image updates are permitted (${item.address}).`);
        check(before.function_name === addresses[item.address] && after.function_name === before.function_name &&
            after.image_uri === candidate.imageUri && after.package_type === "Image", "function or image target.");
        const expectedVariables = item.address === "aws_lambda_function.renderer[0]"
            ? { STORY_API_ORIGIN: ORIGIN, STORY_BUILD_ID: candidate.sourceDigest }
            : { STORY_API_ORIGIN: ORIGIN };
        check(isDeepStrictEqual(after.environment, [{ variables: expectedVariables }]), "runtime environment.");
        const mutable = new Set(["image_uri", "environment", "last_modified", "qualified_arn", "qualified_invoke_arn",
            "source_code_hash", "source_code_size", "version"]);
        for (const key of new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(unknown)])) {
            if (!mutable.has(key))
                check(!containsUnknown(unknown[key]) && isDeepStrictEqual(before[key], after[key]), `unexpected function change: ${key}.`);
        }
        if (!unchanged)
            updated.push(item.address);
    }
    check(plan.resource_changes?.length === 25, "complete Development resource inventory.");
    for (const output of Object.values(plan.output_changes ?? {}))
        check(isDeepStrictEqual(output.actions, ["no-op"]), "unexpected output change.");
    return { imagePlanVerified: true, updateCount: updated.length, updated, creates: 0, deletes: 0, observations, applied: false };
}
export async function prepareDevelopmentImage(candidate, env = process.env, { recoveryCandidates } = {}) {
    const call = await createDevelopmentCICall(env);
    // Provider 6.62.0 drops non-404 HeadBucket errors and reports an empty result
    // as missing. Fail explicitly before Terraform can propose replacement.
    await call(["s3api", "head-bucket", "--bucket", (NAME) + "-" + protectedConfig("awsAccountId") + "-ap-southeast-2", "--expected-bucket-owner", protectedConfig("awsAccountId")]);
    check(env.GITHUB_WORKFLOW_REF === `bentbrain/bent-mono/.github/workflows/native-development.yml@${env.GITHUB_REF}` &&
        process.platform === "linux" && process.arch === "x64" && env.RUNNER_TEMP?.startsWith("/"), "cloud-only execution.");
    process.umask(0o077);
    const directory = await mkdtemp(join(env.RUNNER_TEMP, "native-plan-"));
    const archive = join(directory, "terraform.zip");
    const response = await fetch("https://releases.hashicorp.com/terraform/1.12.2/terraform_1.12.2_linux_amd64.zip", {
        redirect: "error", signal: AbortSignal.timeout(30000),
    });
    check(response.ok, "Terraform download.");
    const bytes = Buffer.from(await response.arrayBuffer());
    check(hash(bytes) === ZIP_HASH, "pinned Terraform checksum.");
    await writeFile(archive, bytes, { flag: "wx", mode: 0o600 });
    await execute("/usr/bin/unzip", ["-q", archive, "-d", directory], { timeout: 10000 });
    const cliConfig = join(directory, "terraform.rc");
    await writeFile(cliConfig, "disable_checkpoint = true\n", { flag: "wx", mode: 0o600 });
    const childEnv = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: directory,
        AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN: env.AWS_SESSION_TOKEN,
        AWS_REGION: "ap-southeast-2", AWS_DEFAULT_REGION: "ap-southeast-2", AWS_CONFIG_FILE: "/dev/null", AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
        AWS_EC2_METADATA_DISABLED: "true", AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "true", AWS_MAX_ATTEMPTS: "2",
        TF_DATA_DIR: join(directory, "data"), TF_CLI_CONFIG_FILE: cliConfig, TF_IN_AUTOMATION: "true", TF_INPUT: "false", CHECKPOINT_DISABLE: "1" };
    const run = async (args) => {
        try {
            return await execute(join(directory, "terraform"), args, { cwd: MODULE, env: childEnv, encoding: "utf8", timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
        }
        catch (error) {
            // Plans/state may contain private environment values. Report only a
            // service/action name, never raw Terraform stdout/stderr or plan JSON.
            console.error(JSON.stringify({ terraformFailure: args[0], ...terraformFailureSummary(error) }));
            let diagnostic = [error.stdout, error.stderr].filter(value => typeof value === "string").join("\n");
            for (const value of [env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY, env.AWS_SESSION_TOKEN, env.CLOUDFLARE_API_TOKEN]) {
                if (value)
                    diagnostic = diagnostic.replaceAll(value, "<REDACTED>");
            }
            const file = join(directory, `${args[0]}-diagnostic.txt`);
            await writeFile(file, diagnostic, { flag: "wx", mode: 0o600 });
            const diagnosticKey = `source/ci-diagnostics/${env.GITHUB_RUN_ID}/${hash(diagnostic)}.txt`;
            const saved = await call(["s3api", "put-object", "--bucket", (NAME) + "-" + protectedConfig("awsAccountId") + "-ap-southeast-2", "--expected-bucket-owner", protectedConfig("awsAccountId"), "--key", diagnosticKey, "--body", file, "--if-none-match", "*", "--server-side-encryption", "AES256"]);
            console.error(JSON.stringify({ privateDiagnosticSaved: true, key: diagnosticKey, version: saved.VersionId, sha256: hash(diagnostic) }));
            throw new Error(`Guarded CI Terraform ${args[0]} failed; private output was not logged.`);
        }
    };
    await run(["init", "-input=false", "-lockfile=readonly", "-no-color"]);
    const planPath = join(directory, "candidate.tfplan");
    await run(["plan", "-input=false", "-no-color", "-parallelism=1", "-lock-timeout=0s", `-out=${planPath}`,
        "-var=ci_execution=true", `-var=image_digest=${candidate.imageDigest}`, `-var=build_id=${candidate.sourceDigest}`, `-var=api_origin=${ORIGIN}`]);
    const output = await run(["show", "-json", planPath]);
    const plan = JSON.parse(output.stdout);
    await writeFile(join(directory, "candidate-plan.json"), output.stdout, { flag: "wx", mode: 0o600 });
    let review;
    try {
        review = inspectDevelopmentImagePlan(plan, candidate, recoveryCandidates);
    }
    catch (error) {
        console.error(JSON.stringify({ planRejected: true, complete: plan.complete, errored: plan.errored,
            drift: plan.resource_drift?.map(item => ({ address: item.address, actions: item.change.actions,
                fields: Object.keys(item.change.after ?? {}).filter(key => !isDeepStrictEqual(item.change.before?.[key], item.change.after[key])) })),
            changes: plan.resource_changes?.filter(item => !isDeepStrictEqual(item.change.actions, ["no-op"]))
                .map(item => ({ address: item.address, actions: item.change.actions })) }));
        const diagnosticKey = `source/ci-diagnostics/${env.GITHUB_RUN_ID}/${hash(output.stdout)}.json`;
        const saved = await call(["s3api", "put-object", "--bucket", (NAME) + "-" + protectedConfig("awsAccountId") + "-ap-southeast-2", "--expected-bucket-owner", protectedConfig("awsAccountId"), "--key", diagnosticKey, "--body", join(directory, "candidate-plan.json"), "--if-none-match", "*", "--server-side-encryption", "AES256"]);
        console.error(JSON.stringify({ privatePlanSaved: true, key: diagnosticKey, version: saved.VersionId, sha256: hash(output.stdout) }));
        throw error;
    }
    const evidence = { ...review, planSha256: hash(await readFile(planPath)), terraformVersion: "1.12.2", remoteStateLocked: true,
        sourceCommit: env.GITHUB_SHA, imageDigest: candidate.imageDigest, sourceDigest: candidate.sourceDigest };
    let attempted = false;
    return { review: evidence,
        preserve: async (store) => {
            const planBytes = await readFile(planPath);
            check(hash(planBytes) === evidence.planSha256, "saved plan changed before preservation.");
            return store.save("candidate.tfplan", planBytes);
        }, apply: async (cf, releaseId) => {
            check(!attempted, "saved plan was already attempted; inspect state before recovery.");
            await assertReleasePaused(cf, releaseId);
            check((await inspectDevelopmentDrain(cf, releaseId)).drained === true, "admissions must be drained.");
            check((await cf.query("SELECT name FROM pragma_table_info('story_video_jobs') WHERE name = 'execution_id'"))[0].results.length === 1, "execution fence migration.");
            check(hash(await readFile(planPath)) === evidence.planSha256, "saved plan bytes changed.");
            inspectDevelopmentImagePlan(JSON.parse((await run(["show", "-json", planPath])).stdout), candidate, recoveryCandidates);
            attempted = true;
            await run(["apply", "-input=false", "-no-color", "-parallelism=1", "-lock-timeout=0s", planPath]);
            await assertReleasePaused(cf, releaseId);
            return { ...evidence, applied: true };
        } };
}
async function planDevelopmentImage(candidate, env = process.env) {
    return (await prepareDevelopmentImage(candidate, env)).review;
}
