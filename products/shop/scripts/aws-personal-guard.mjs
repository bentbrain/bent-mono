import { protectedConfig } from "./protected-config.mjs";
import { fileURLToPath } from "node:url";
export const PERSONAL_ACCOUNT = protectedConfig("awsAccountId");
export const PERSONAL_PROFILE = "personal-dev";
export const PERSONAL_REGION = "ap-southeast-2";
export const PERSONAL_CONFIG_PATH = fileURLToPath(new URL("../.data/aws-personal/config", import.meta.url));
const CONFIG_LINES = [
    "[profile personal-dev]", "sso_session = personal-dev",
    "sso_account_id = " + protectedConfig("awsAccountId"),
    "sso_role_name = AdministratorAccess",
    "region = ap-southeast-2", "[sso-session personal-dev]",
    "sso_start_url = " + protectedConfig("ssoStartUrl"),
    "sso_region = ap-southeast-2", "sso_registration_scopes = sso:account:access",
];
export function validatePersonalConfig(text) {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (JSON.stringify(lines) !== JSON.stringify(CONFIG_LINES)) {
        throw new Error("Refusing AWS access: the isolated personal SSO configuration does not match the approved account.");
    }
}
export function personalEnvironment(parent) {
    const env = {};
    // Preserve the real home only for the specifically named personal SSO cache.
    // No shell startup, credential variables, proxy, SDK injection or work config.
    for (const key of ["HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"]) {
        if (parent[key])
            env[key] = parent[key];
    }
    return {
        ...env, PATH: "/usr/local/bin:/usr/bin:/bin",
        AWS_CONFIG_FILE: PERSONAL_CONFIG_PATH,
        AWS_SHARED_CREDENTIALS_FILE: "/dev/null", BOTO_CONFIG: "/dev/null",
        AWS_PROFILE: PERSONAL_PROFILE, AWS_DEFAULT_PROFILE: PERSONAL_PROFILE,
        AWS_REGION: PERSONAL_REGION, AWS_DEFAULT_REGION: PERSONAL_REGION,
        AWS_EC2_METADATA_DISABLED: "true", AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "true",
        AWS_CLI_AUTO_PROMPT: "off", AWS_PAGER: "", AWS_MAX_ATTEMPTS: "2",
    };
}
const OPERATIONS = new Set([
    "sts get-caller-identity", "sso login", "sso list-account-roles", "lambda get-account-settings",
    "service-quotas get-service-quota", "service-quotas list-service-quotas",
    "service-quotas list-requested-service-quota-change-history-by-quota",
    "service-quotas get-requested-service-quota-change",
    "service-quotas request-service-quota-increase",
    "cloudformation describe-stacks", "cloudformation describe-stack-events",
    "cloudformation validate-template", "cloudformation create-stack",
    "cloudformation update-stack", "cloudformation create-change-set",
    "cloudformation describe-change-set", "cloudformation execute-change-set",
    "codebuild start-build", "codebuild batch-get-builds",
    "ecr describe-repositories", "ecr describe-images",
    "lambda get-function", "lambda get-function-configuration", "lambda invoke",
    "lambda get-function-concurrency", "lambda put-function-concurrency",
    "lambda list-provisioned-concurrency-configs", "s3 cp", "s3api head-object", "s3api head-bucket",
    "logs filter-log-events", "logs get-log-events",
    "cloudwatch get-metric-statistics",
    "support describe-cases",
    "iam get-user", "iam list-access-keys", "iam create-access-key",
    "iam get-open-id-connect-provider", "iam get-role", "iam get-policy",
    "kms describe-key",
    "s3api put-object", "s3api get-bucket-versioning", "s3api get-bucket-encryption", "s3api get-public-access-block",
]);
const FORBIDDEN_OPTIONS = [
    "--profile", "--region", "--endpoint-url", "--no-sign-request", "--debug",
    "--ca-bundle", "--no-verify-ssl", "--cli-auto-prompt", "--output",
    "--sso-session", "--access-token",
];
export function validatePersonalArguments(args) {
    if (args.length === 1 && args[0] === "version")
        return;
    const stateBucket = "forever-tee-terraform-state-" + protectedConfig("awsAccountId") + "-ap-southeast-2";
    if (args[0] === "s3api" && ["get-bucket-versioning", "get-bucket-encryption", "get-public-access-block"].includes(args[1]) &&
        JSON.stringify(args.slice(2)) !== JSON.stringify(["--bucket", stateBucket, "--expected-bucket-owner", PERSONAL_ACCOUNT])) {
        throw new Error("State configuration reads require the exact personal state bucket and owner.");
    }
    if (args[0] === "s3api" && args[1] === "put-object") {
        const bootstrap = args[7] === "story-video/bootstrap/terraform.tfstate";
        const prefix = ["s3api", "put-object", "--bucket", stateBucket, "--expected-bucket-owner", PERSONAL_ACCOUNT,
            "--key", bootstrap ? "story-video/bootstrap/terraform.tfstate" : "story-video/development/terraform.tfstate", "--if-none-match", "*", "--server-side-encryption", "aws:kms",
            "--ssekms-key-id", "arn:aws:kms:ap-southeast-2:" + protectedConfig("awsAccountId") + ":key/" + protectedConfig("stateKmsKeyId"), "--body"];
        const directory = fileURLToPath(new URL(bootstrap ? "../.data/terraform-video-bootstrap/" : "../.data/terraform-story-video/", import.meta.url));
        const pattern = bootstrap ? /^bootstrap-migration-[A-Za-z0-9]{6}\/bootstrap-before\.tfstate$/ : /^migration-[A-Za-z0-9]{6}\/renderer-before\.tfstate$/;
        if (args.length !== 18 || JSON.stringify(args.slice(0, 15)) !== JSON.stringify(prefix) ||
            !args[15].startsWith(directory) || !pattern.test(args[15].slice(directory.length)) ||
            args[16] !== "--content-md5" || !/^[A-Za-z0-9+/]{22}==$/.test(args[17])) {
            throw new Error("State upload permits only the separately reviewed Development/bootstrap backup, exact KMS key and conditional creation.");
        }
    }
    if (args[0] === "kms" && JSON.stringify(args) !== JSON.stringify([
        "kms", "describe-key", "--key-id", "alias/forever-tee-video-development-state",
    ]))
        throw new Error("KMS discovery is limited to the exact Development state alias.");
    if (args[0] === "iam") {
        // Production bootstrap collision checks only. This does not permit IAM
        // writes, arbitrary discovery, or use of a Production runtime service key.
        const productionRead = args.length === 4 && ((args[1] === "get-role" && args[2] === "--role-name" && ["ci", "runtime", "failures"].some(kind => args[3] === `forever-tee-video-production-${kind}`)) ||
            (args[1] === "get-user" && args[2] === "--user-name" && args[3] === "forever-tee-video-production-invoker") ||
            (args[1] === "get-policy" && args[2] === "--policy-arn" && ["ci", "runtime", "failures", "invoker"].some(kind => args[3] === `arn:aws:iam::${PERSONAL_ACCOUNT}:policy/forever-tee-video-production-${kind}-boundary`)));
        // Owner-approved Development bootstrap discovery. No IAM write or list
        // operations are added; existing providers/roles must never be taken over.
        const discovery = {
            "get-open-id-connect-provider": ["--open-id-connect-provider-arn", `arn:aws:iam::${PERSONAL_ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`],
            "get-role": ["--role-name", "forever-tee-video-development-ci"],
            "get-policy": ["--policy-arn", `arn:aws:iam::${PERSONAL_ACCOUNT}:policy/forever-tee-video-development-ci-boundary`],
        };
        const target = Object.hasOwn(discovery, args[1]) ? discovery[args[1]]
            : ["--user-name", "forever-tee-video-development-invoker"];
        if (!productionRead && (args.length !== 4 || args[2] !== target[0] || args[3] !== target[1])) {
            throw new Error("IAM operations are limited to the exact Development invoker and bootstrap discovery targets.");
        }
    }
    if (args[0] === "service-quotas" && args[1] === "request-service-quota-increase") {
        const approvedRequest = [
            "service-quotas", "request-service-quota-increase",
            "--service-code", "lambda", "--quota-code", "L-B99A9384",
            "--desired-value", "1000",
        ];
        if (JSON.stringify(args) !== JSON.stringify(approvedRequest)) {
            throw new Error("Only the owner-approved Lambda concurrency increase to 1000 is permitted.");
        }
    }
    if (args[0] === "sso" && args[1] === "list-account-roles" && args.length !== 2) {
        throw new Error("Personal SSO role discovery accepts no account or credential overrides.");
    }
    if (!OPERATIONS.has(args.slice(0, 2).join(" "))) {
        throw new Error("AWS operation not approved by the project runner.");
    }
    for (const argument of args) {
        const option = argument.split("=", 1)[0];
        if (option === "--" || (option.startsWith("--") && FORBIDDEN_OPTIONS.some((blocked) => blocked.startsWith(option)))) {
            throw new Error("AWS credential, endpoint and global configuration overrides are forbidden.");
        }
        for (const match of argument.matchAll(/arn:[^:\s]+:[^:\s]+:[^:\s]*:(\d{12}):/g)) {
            if (match[1] !== PERSONAL_ACCOUNT)
                throw new Error("Cross-account AWS resource references are forbidden.");
        }
    }
}
function validatePersonalIdentity(identity) {
    if (identity?.Account !== PERSONAL_ACCOUNT ||
        typeof identity.Arn !== "string" ||
        !identity.Arn.startsWith(`arn:aws:sts::${PERSONAL_ACCOUNT}:assumed-role/AWSReservedSSO_AdministratorAccess_`)) {
        throw new Error("AWS identity is not the approved personal SSO account. No operation was performed.");
    }
}
export async function guardedPersonalCall(args, { config, environment, execute, inspectSsoRoles }) {
    validatePersonalArguments(args);
    validatePersonalConfig(config);
    const env = personalEnvironment(environment);
    if (args.length === 1 && args[0] === "version")
        return execute(["--version"], env);
    if (args[0] === "sso" && args[1] === "list-account-roles")
        return inspectSsoRoles(env);
    const options = ["--profile", PERSONAL_PROFILE, "--region", PERSONAL_REGION, "--output", "json", "--no-cli-pager"];
    if (args[0] === "sso")
        return execute([...args, ...options], env);
    const identityText = await execute(["sts", "get-caller-identity", ...options], env);
    validatePersonalIdentity(JSON.parse(identityText));
    if (args[0] === "sts")
        return identityText;
    return execute([...args, ...options], env);
}
