import { protectedConfig } from "./protected-config.mjs";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createDevelopmentCICall } from "./native-ci-aws.mjs";
import { packageAppSource } from "../workers/video-renderer/aws-lambda/package-app-source.mjs";
import { EXECUTION_PROTOCOL } from "../workers/video-renderer/aws-lambda/app-environment.mjs";
const ACCOUNT = protectedConfig("awsAccountId"), REGION = "ap-southeast-2", PROJECT = "forever-tee-video-development";
const BUCKET = `${PROJECT}-${ACCOUNT}-${REGION}`;
const check = (value, message) => { if (!value)
    throw new Error(`Native build verification failed: ${message}`); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const execute = promisify(execFile);
export async function verifyCandidateCheckout(env) {
    const head = await execute("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
    const status = await execute("git", ["status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" });
    check(head.stdout.trim() === env.GITHUB_SHA && status.stdout.trim() === "", "clean checkout of the exact workflow commit.");
}
export function verifyBuildConfiguration(value) {
    let buildspec;
    try {
        buildspec = JSON.parse(value?.source?.buildspec);
    }
    catch { /* Rejected below. */ }
    check(JSON.stringify(buildspec) === JSON.stringify({ phases: { build: { commands: ["bash aws-lambda/cloud-build-app.sh"] } }, version: "0.2" }), "exact reviewed build commands.");
    check(value.environment?.type === "LINUX_CONTAINER" && value.environment.image === "aws/codebuild/standard:7.0" &&
        value.environment.computeType === "BUILD_GENERAL1_SMALL" && value.environment.privilegedMode === true, "reviewed cloud build environment.");
}
export function verifyCloudBuild(build, expected) {
    verifyBuildConfiguration(build);
    check(build?.buildStatus === "SUCCEEDED" && build.buildComplete === true && build.projectName === PROJECT &&
        build.arn === `arn:aws:codebuild:${REGION}:${ACCOUNT}:build/${build.id}` &&
        new RegExp(`^${PROJECT}:[0-9a-f-]{36}$`).test(build.id) &&
        build.serviceRole === `arn:aws:iam::${ACCOUNT}:role/${PROJECT}-build`, "build identity or completion.");
    // AWS documents resolvedSourceVersion as inapplicable to S3. sourceVersion
    // is its version ID; the uploaded bytes were read back at that exact version.
    check(build.source?.type === "S3" && build.source.location === `${BUCKET}/${expected.sourceKey}` &&
        build.sourceVersion === expected.sourceVersion, "version-pinned source.");
    for (const [name, value] of Object.entries({ SOURCE_DIGEST: expected.sourceDigest, SOURCE_COMMIT: expected.sourceCommit, SOURCE_ZIP_SHA256: expected.zipSha256, SHOP_AWS_ACCOUNT_ID: ACCOUNT })) {
        const matches = build.environment?.environmentVariables?.filter(variable => variable.name === name);
        check(matches?.length === 1 && matches[0].type === "PLAINTEXT" && matches[0].value === value, "build source inputs.");
    }
    return { buildId: build.id, buildArn: build.arn };
}
export async function runCloudBuild(env = process.env) {
    const call = await createDevelopmentCICall(env);
    check(env.GITHUB_WORKFLOW_REF === `bentbrain/bent-mono/.github/workflows/native-development.yml@${env.GITHUB_REF}` &&
        typeof env.RUNNER_TEMP === "string" && isAbsolute(env.RUNNER_TEMP), "cloud-only build workflow.");
    await verifyCandidateCheckout(env);
    process.umask(0o077);
    const directory = await mkdtemp(join(env.RUNNER_TEMP, "native-source-"));
    const repository = await call(["ecr", "describe-repositories", "--repository-names", PROJECT]);
    check(repository.repositories?.length === 1 && repository.repositories[0].registryId === ACCOUNT &&
        repository.repositories[0].imageTagMutability === "IMMUTABLE" && !repository.repositories[0].imageTagMutabilityExclusionFilters?.length, "ECR must retain immutable image tags without exclusions.");
    const project = await call(["codebuild", "batch-get-projects", "--names", PROJECT]);
    check(project.projects?.length === 1 && project.projects[0].serviceRole === `arn:aws:iam::${ACCOUNT}:role/${PROJECT}-build` &&
        project.projects[0].arn === `arn:aws:codebuild:${REGION}:${ACCOUNT}:project/${PROJECT}` &&
        project.projects[0].concurrentBuildLimit === 1 && project.projects[0].source?.type === "S3" &&
        !project.projects[0].environment?.environmentVariables?.length, "isolated CodeBuild project.");
    verifyBuildConfiguration(project.projects[0]);
    const packaged = await packageAppSource(directory);
    // A candidate is built once. Reusing an existing image needs its original
    // verified release record, not an unverified tag or a second build.
    try {
        await call(["ecr", "describe-images", "--repository-name", PROJECT, "--image-ids", `imageTag=source-${packaged.sourceDigest}`]);
        throw new Error("Source image already exists; verify its original candidate record instead of rebuilding or replacing it.");
    }
    catch (error) {
        if (error.code !== "ImageNotFoundException")
            throw error;
    }
    const zip = await readFile(packaged.zip);
    const zipSha256 = hash(zip);
    const sourceKey = `source/${env.GITHUB_SHA}/${env.GITHUB_RUN_ID}/${zipSha256}.zip`;
    const bucket = ["--bucket", BUCKET, "--expected-bucket-owner", ACCOUNT];
    const uploaded = await call(["s3api", "put-object", ...bucket, "--key", sourceKey, "--body", packaged.zip,
        "--if-none-match", "*", "--server-side-encryption", "AES256", "--content-md5", createHash("md5").update(zip).digest("base64")]);
    check(typeof uploaded.VersionId === "string" && uploaded.VersionId !== "null", "source version acknowledgement.");
    const copy = join(directory, "source-readback.zip");
    await call(["s3api", "get-object", ...bucket, "--key", sourceKey, "--version-id", uploaded.VersionId, copy]);
    check(hash(await readFile(copy)) === zipSha256, "uploaded source bytes.");
    const expected = { sourceDigest: packaged.sourceDigest, sourceKey, sourceVersion: uploaded.VersionId, sourceCommit: env.GITHUB_SHA, zipSha256 };
    const started = await call(["codebuild", "start-build", "--project-name", PROJECT,
        "--source-location-override", `${BUCKET}/${sourceKey}`, "--source-version", uploaded.VersionId,
        "--idempotency-token", `native-${env.GITHUB_RUN_ID}-${env.GITHUB_SHA.slice(0, 12)}`,
        "--environment-variables-override", `name=SOURCE_DIGEST,value=${expected.sourceDigest},type=PLAINTEXT`,
        `name=SOURCE_COMMIT,value=${expected.sourceCommit},type=PLAINTEXT`, `name=SOURCE_ZIP_SHA256,value=${zipSha256},type=PLAINTEXT`, `name=SHOP_AWS_ACCOUNT_ID,value=${ACCOUNT},type=PLAINTEXT`]);
    const buildId = started.build?.id;
    check(typeof buildId === "string" && new RegExp(`^${PROJECT}:[0-9a-f-]{36}$`).test(buildId), "accepted build ID.");
    await writeFile(join(directory, "build-started.json"), JSON.stringify({ buildId, ...expected }), { flag: "wx", mode: 0o600 });
    console.info(JSON.stringify({ buildStarted: buildId, sourceCommit: env.GITHUB_SHA, sourceDigest: expected.sourceDigest }));
    const deadline = Date.now() + 25 * 60000;
    let complete;
    let phase;
    while (Date.now() < deadline) {
        const response = await call(["codebuild", "batch-get-builds", "--ids", buildId]);
        check(response.builds?.length === 1 && !response.buildsNotFound?.length, "build lookup.");
        const current = response.builds[0];
        if (current.currentPhase !== phase) {
            phase = current.currentPhase;
            console.info(JSON.stringify({ buildId, phase }));
        }
        if (current.buildComplete) {
            complete = current;
            break;
        }
        await new Promise(resolve => setTimeout(resolve, 10000));
    }
    const verified = verifyCloudBuild(complete, expected);
    check(verified.buildId === buildId, "completed build differs from accepted build.");
    const images = await call(["ecr", "describe-images", "--repository-name", PROJECT, "--image-ids", `imageTag=source-${expected.sourceDigest}`]);
    const image = images.imageDetails?.[0];
    check(images.imageDetails?.length === 1 && image.registryId === ACCOUNT && image.repositoryName === PROJECT &&
        /^sha256:[a-f0-9]{64}$/.test(image.imageDigest) && image.imageTags?.includes(`source-${expected.sourceDigest}`), "immutable image.");
    const candidate = { schemaVersion: 1, environment: "development", accountId: ACCOUNT, region: REGION,
        ...expected, ...verified, imageDigest: image.imageDigest, imageUri: `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${PROJECT}@${image.imageDigest}`,
        executionProtocol: EXECUTION_PROTOCOL, rendererVersion: "story-video-renderer-v7", githubRunId: env.GITHUB_RUN_ID,
        createdAt: new Date().toISOString(), deploymentPerformed: false };
    const recordPath = join(directory, "candidate.json");
    await writeFile(recordPath, JSON.stringify(candidate), { flag: "wx", mode: 0o600 });
    const recordKey = `source/candidates/${expected.sourceDigest}/${env.GITHUB_RUN_ID}.json`;
    const record = await call(["s3api", "put-object", ...bucket, "--key", recordKey, "--body", recordPath, "--if-none-match", "*", "--server-side-encryption", "AES256"]);
    check(typeof record.VersionId === "string" && record.VersionId !== "null", "candidate version acknowledgement.");
    return { candidateVerified: true, ...candidate, candidateKey: recordKey, candidateVersion: record.VersionId, candidateSha256: hash(await readFile(recordPath)) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        console.info(JSON.stringify(await runCloudBuild()));
    }
    catch (error) {
        console.error(error instanceof Error ? error.message : "Native cloud build failed.");
        process.exitCode = 1;
    }
}
