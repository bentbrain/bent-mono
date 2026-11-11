import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createDevelopmentCICall } from "./native-ci-aws.mjs";
import { verifyCandidateCheckout, verifyCloudBuild } from "./native-ci-build.mjs";
import { packageAppSource } from "../workers/video-renderer/aws-lambda/package-app-source.mjs";
import { assertDeployableImage } from "./native-ci-image-policy.mjs";
const ACCOUNT = protectedConfig("awsAccountId"), REGION = "ap-southeast-2", PROJECT = "forever-tee-video-development";
const BUCKET = `${PROJECT}-${ACCOUNT}-${REGION}`;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const check = (value, reason) => { if (!value)
    throw new Error(`Native candidate verification failed: ${reason}`); };
export async function developmentCandidateReceipt(env = process.env) {
    return env.NATIVE_CANDIDATE_RECEIPT
        ? JSON.parse(env.NATIVE_CANDIDATE_RECEIPT)
        : JSON.parse(resolveProtectedTemplate(await readFile(new URL("../infra/story-video-lambda/development-candidate.json", import.meta.url), "utf8")));
}
export function verifyCandidateRecord(receipt, candidate, currentDigest) {
    assertDeployableImage(candidate?.imageDigest);
    check(receipt.schemaVersion === 1 && /^[a-f0-9]{64}$/.test(currentDigest) && receipt.sourceDigest === currentDigest &&
        /^[a-f0-9]{64}$/.test(receipt.candidateSha256) && typeof receipt.candidateVersion === "string" &&
        receipt.candidateVersion.length > 0 && receipt.candidateVersion !== "null", "pinned candidate receipt and current source.");
    check(candidate.schemaVersion === 1 && candidate.environment === "development" && candidate.accountId === ACCOUNT &&
        candidate.region === REGION && candidate.sourceDigest === currentDigest && /^[a-f0-9]{40}$/.test(candidate.sourceCommit) &&
        /^\d+$/.test(candidate.githubRunId) && /^[a-f0-9]{64}$/.test(candidate.zipSha256), "source provenance fields.");
    check(receipt.candidateKey === `source/candidates/${currentDigest}/${candidate.githubRunId}.json` &&
        candidate.sourceKey === `source/${candidate.sourceCommit}/${candidate.githubRunId}/${candidate.zipSha256}.zip` &&
        typeof candidate.sourceVersion === "string" && candidate.sourceVersion.length > 0 && candidate.sourceVersion !== "null", "version-pinned candidate and source keys.");
    check(candidate.executionProtocol === "claim-v1" && candidate.rendererVersion === "story-video-renderer-v7" &&
        /^sha256:[a-f0-9]{64}$/.test(candidate.imageDigest) && candidate.imageUri === `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${PROJECT}@${candidate.imageDigest}` &&
        candidate.deploymentPerformed === false, "immutable Development image and protocol.");
    return candidate;
}
export async function loadVerifiedCandidate(receipt, env = process.env, dependencies = {}) {
    const call = await createDevelopmentCICall(env, dependencies.run);
    check(env.GITHUB_WORKFLOW_REF === `bentbrain/bent-mono/.github/workflows/native-development.yml@${env.GITHUB_REF}` &&
        env.RUNNER_TEMP?.startsWith("/"), "cloud-only candidate verification.");
    await (dependencies.verifyCheckout ?? verifyCandidateCheckout)(env);
    check(typeof receipt.candidateKey === "string" && /^source\/candidates\/[a-f0-9]{64}\/\d+\.json$/.test(receipt.candidateKey) &&
        typeof receipt.candidateVersion === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._~+/=-]{0,1023}$/.test(receipt.candidateVersion), "receipt object path.");
    process.umask(0o077);
    const directory = await mkdtemp(join(env.RUNNER_TEMP, "native-candidate-"));
    const recordPath = join(directory, "candidate.json");
    const bucket = ["--bucket", BUCKET, "--expected-bucket-owner", ACCOUNT];
    await call(["s3api", "get-object", ...bucket, "--key", receipt.candidateKey, "--version-id", receipt.candidateVersion, recordPath]);
    const bytes = await readFile(recordPath);
    check(bytes.length < 16384 && hash(bytes) === receipt.candidateSha256, "candidate record bytes.");
    const packaged = await (dependencies.packageSource ?? packageAppSource)(directory);
    const candidate = verifyCandidateRecord(receipt, JSON.parse(bytes), packaged.sourceDigest);
    check(new RegExp(`^${PROJECT}:[0-9a-f-]{36}$`).test(candidate.buildId), "original build ID.");
    const sourcePath = join(directory, "source.zip");
    await call(["s3api", "get-object", ...bucket, "--key", candidate.sourceKey, "--version-id", candidate.sourceVersion, sourcePath]);
    check(hash(await readFile(sourcePath)) === candidate.zipSha256, "original source version bytes.");
    const response = await call(["codebuild", "batch-get-builds", "--ids", candidate.buildId]);
    check(response.builds?.length === 1 && !response.buildsNotFound?.length, "original build record.");
    const verified = verifyCloudBuild(response.builds[0], candidate);
    check(verified.buildId === candidate.buildId && verified.buildArn === candidate.buildArn, "original build identity.");
    const repositories = await call(["ecr", "describe-repositories", "--repository-names", PROJECT]);
    check(repositories.repositories?.length === 1 && repositories.repositories[0].registryId === ACCOUNT &&
        repositories.repositories[0].imageTagMutability === "IMMUTABLE" && !repositories.repositories[0].imageTagMutabilityExclusionFilters?.length, "immutable repository without exclusions.");
    const images = await call(["ecr", "describe-images", "--repository-name", PROJECT, "--image-ids", `imageTag=source-${candidate.sourceDigest}`]);
    const image = images.imageDetails?.[0];
    check(images.imageDetails?.length === 1 && image.registryId === ACCOUNT && image.repositoryName === PROJECT &&
        image.imageDigest === candidate.imageDigest, "original image digest.");
    return { ...candidate, ...receipt, candidateVerified: true, reused: true, verifiedForCommit: env.GITHUB_SHA };
}
