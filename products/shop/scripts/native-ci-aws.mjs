import { protectedConfig } from "./protected-config.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { assertActionsIdentityContext } from "./native-ci-identity.mjs";
const execute = promisify(execFile);
export const STATE_BUCKET = "forever-tee-terraform-state-" + protectedConfig("awsAccountId") + "-ap-southeast-2";
export const STATE_KMS = "arn:aws:kms:ap-southeast-2:" + protectedConfig("awsAccountId") + ":key/" + protectedConfig("stateKmsKeyId");
const ACCOUNT = protectedConfig("awsAccountId");
const REGION = "ap-southeast-2";
const ROLE = "forever-tee-video-development-ci";
const fail = () => { throw new Error("Native CI AWS verification failed; no application deployment attempted."); };
export async function createDevelopmentCICall(env = process.env, run = execute) {
    assertActionsIdentityContext(env);
    if (!["native-ci-identity.yml", "native-development.yml"].some(file => env.GITHUB_WORKFLOW_REF === `bentbrain/bent-mono/.github/workflows/${file}@${env.GITHUB_REF}`) ||
        env.AWS_REGION !== REGION || env.AWS_DEFAULT_REGION !== REGION ||
        ![env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY, env.AWS_SESSION_TOKEN].every(value => typeof value === "string" && value.length > 0))
        fail();
    const childEnv = { PATH: "/usr/local/bin:/usr/bin:/bin", AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN: env.AWS_SESSION_TOKEN,
        AWS_REGION: REGION, AWS_DEFAULT_REGION: REGION, AWS_CONFIG_FILE: "/dev/null", AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
        BOTO_CONFIG: "/dev/null", AWS_EC2_METADATA_DISABLED: "true", AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "true",
        AWS_PAGER: "", AWS_CLI_AUTO_PROMPT: "off", AWS_MAX_ATTEMPTS: "2" };
    const call = async (args) => {
        try {
            const output = await run("aws", [...args, "--region", REGION, "--output", "json", "--no-cli-pager"], { env: childEnv, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 });
            return JSON.parse(output.stdout);
        }
        catch (error) {
            // Negative permission/lock tests may inspect only the service error code,
            // never raw command output, credentials or object contents.
            const code = typeof error.stderr === "string" ? /\(([A-Za-z0-9]+)\) when calling the [A-Za-z0-9]+ operation/.exec(error.stderr)?.[1] : undefined;
            if (code)
                throw Object.assign(new Error("Scoped CI AWS request failed."), { code });
            fail();
        }
    };
    const identity = await call(["sts", "get-caller-identity"]);
    if (identity.Account !== ACCOUNT || identity.Arn !== `arn:aws:sts::${ACCOUNT}:assumed-role/${ROLE}/native-${env.GITHUB_RUN_ID}`)
        fail();
    return call;
}
export async function verifyCIStorage(env = process.env, run = execute) {
    const call = await createDevelopmentCICall(env, run);
    const bucketArgs = ["--bucket", STATE_BUCKET, "--expected-bucket-owner", ACCOUNT];
    const versioning = await call(["s3api", "get-bucket-versioning", ...bucketArgs]);
    if (versioning.Status !== "Enabled")
        fail();
    const encryption = await call(["s3api", "get-bucket-encryption", ...bucketArgs]);
    const rules = encryption.ServerSideEncryptionConfiguration?.Rules;
    if (rules?.length !== 1 || rules[0].BucketKeyEnabled !== false ||
        rules[0].ApplyServerSideEncryptionByDefault?.SSEAlgorithm !== "aws:kms" ||
        rules[0].ApplyServerSideEncryptionByDefault?.KMSMasterKeyID !== STATE_KMS)
        fail();
    const access = await call(["s3api", "get-public-access-block", ...bucketArgs]);
    if (!["BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"]
        .every(key => access.PublicAccessBlockConfiguration?.[key] === true))
        fail();
    return { ciAWSVerified: true, accountId: ACCOUNT, region: REGION, role: ROLE, stateBucket: STATE_BUCKET,
        versioned: true, kmsEncrypted: true, publicAccessBlocked: true, mutationsAttempted: false,
        sourceCommit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        console.info(JSON.stringify(await verifyCIStorage()));
    }
    catch {
        console.error("Native CI AWS verification failed; no credentials logged or application deployment attempted.");
        process.exitCode = 1;
    }
}
