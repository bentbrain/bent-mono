import { protectedConfig } from "./protected-config.mjs";
import { productionAlertReadPermissions, productionArn as arn, PRODUCTION_NAME as NAME, PRODUCTION_ACCOUNT as ACCOUNT, PRODUCTION_REGION as REGION } from "./native-production-permissions.mjs";
const QUALIFIED_REPOSITORY = "forever-tee-video-development";
export const QUALIFIED_ECR_ARN = arn("ecr", `repository/${QUALIFIED_REPOSITORY}`);
const QUALIFIED_BUCKET = `arn:aws:s3:::${QUALIFIED_REPOSITORY}-${ACCOUNT}-${REGION}`;
const LEGACY_PRODUCTION_CANDIDATE_RESOURCES = [
    (QUALIFIED_BUCKET) + "/source/candidates/" + protectedConfig("resource_6a33e99d0409") + "/" + protectedConfig("resource_ba4d5598a02e") + ".json",
    (QUALIFIED_BUCKET) + "/source/c6ced05b00318e1dd73c8414177ae8a89edc1ac1/" + protectedConfig("resource_ba4d5598a02e") + "/*",
    (QUALIFIED_BUCKET) + "/source/releases/native-" + protectedConfig("resource_8d0190ecec7d") + "/*",
];
export const PREVIOUS_PRODUCTION_CANDIDATE_RESOURCES = [
    (QUALIFIED_BUCKET) + "/source/candidates/" + protectedConfig("resource_2ef4a3b7d52c") + "/" + protectedConfig("resource_66a926536d4a") + ".json",
    (QUALIFIED_BUCKET) + "/source/a1f3bbd93f44d88646bd9a4061c5b15211d4ca90/" + protectedConfig("resource_66a926536d4a") + "/*",
    (QUALIFIED_BUCKET) + "/source/releases/native-" + protectedConfig("resource_8d0190ecec7d") + "/*",
];
export const PRODUCTION_CANDIDATE_RESOURCES = [
    (QUALIFIED_BUCKET) + "/source/candidates/" + protectedConfig("resource_04efe2fdbe6d") + "/" + protectedConfig("resource_7acc6e376e5e") + ".json",
    (QUALIFIED_BUCKET) + "/source/" + protectedConfig("qualifiedCandidateSourceCommit") + "/" + protectedConfig("resource_7acc6e376e5e") + "/*",
    (QUALIFIED_BUCKET) + "/source/releases/native-" + protectedConfig("resource_8d0190ecec7d") + "/*",
];
export const RUNTIME_IDENTITIES = ["runtime", "failures", "invoker"];
export const identityName = kind => {
    if (!RUNTIME_IDENTITIES.includes(kind))
        throw new Error("Unknown Production runtime identity.");
    return `${NAME}-${kind}`;
};
export const identityArn = kind => `arn:aws:iam::${ACCOUNT}:${kind === "invoker" ? "user" : "role"}/${identityName(kind)}`;
export const identityBoundaryArn = kind => `arn:aws:iam::${ACCOUNT}:policy/${identityName(kind)}-boundary`;
const allow = (Action, Resource, Condition) => ({ Effect: "Allow", Action, Resource, ...(Condition ? { Condition } : {}) });
export function productionRuntimePermissions(kind) {
    identityName(kind);
    if (kind === "invoker")
        return { Version: "2012-10-17", Statement: [allow("lambda:InvokeFunction", arn("lambda", `function:${NAME}`))] };
    return { Version: "2012-10-17", Statement: [
            allow(["logs:CreateLogStream", "logs:PutLogEvents"], arn("logs", `log-group:/aws/lambda/${NAME}${kind === "failures" ? "-failures" : ""}:*`)),
            allow(kind === "failures" ? ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"] : "sqs:SendMessage", arn("sqs", `${NAME}-failures`)),
            // Same-account Lambda image retrieval through the execution identity. No
            // Development data/state access or ECR policy, tag, image or layer writes.
            allow(["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], QUALIFIED_ECR_ARN),
        ] };
}
export function productionRuntimeTrust() {
    return { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] };
}
export function productionRuntimeTerraform() {
    const resource = { aws_iam_policy: {}, aws_iam_role: {}, aws_iam_role_policy: {}, aws_iam_user: {}, aws_iam_user_policy: {} };
    for (const kind of RUNTIME_IDENTITIES) {
        const key = `production_${kind}`, policy = JSON.stringify(productionRuntimePermissions(kind));
        const lifecycle = { prevent_destroy: true };
        resource.aws_iam_policy[`${key}_boundary`] = { name: `${identityName(kind)}-boundary`, path: "/", policy, tags: { Environment: "production" }, lifecycle };
        const type = kind === "invoker" ? "aws_iam_user" : "aws_iam_role";
        resource[type][key] = { name: identityName(kind), path: "/", permissions_boundary: identityBoundaryArn(kind),
            tags: { Environment: "production" }, depends_on: [`aws_iam_policy.${key}_boundary`], lifecycle,
            ...(kind === "invoker" ? { force_destroy: false } : { max_session_duration: 3600, assume_role_policy: JSON.stringify(productionRuntimeTrust()) }) };
        resource[kind === "invoker" ? "aws_iam_user_policy" : "aws_iam_role_policy"][key] = {
            name: "production-runtime", [kind === "invoker" ? "user" : "role"]: identityName(kind), policy, depends_on: [`${type}.${key}`], lifecycle
        };
    }
    return { resource };
}
function releasePermissions(candidateResources) {
    // The foundation is already created. Retire its creation/configuration writes
    // before adding scoped Lambda release authority. State and evidence survive.
    const retired = new Set(["s3:CreateBucket", "s3:PutBucketPublicAccessBlock", "s3:PutBucketVersioning", "s3:PutEncryptionConfiguration", "s3:PutBucketPolicy",
        "s3:PutBucketTagging", "s3:PutBucketOwnershipControls", "sqs:CreateQueue", "sqs:SetQueueAttributes", "sqs:TagQueue", "logs:CreateLogGroup", "logs:PutRetentionPolicy",
        "logs:TagResource", "logs:TagLogGroup", "sns:CreateTopic", "sns:SetTopicAttributes", "sns:TagResource", "sns:Subscribe"]);
    const statements = productionAlertReadPermissions().Statement.map(item => ({ ...item, Action: [item.Action].flat().filter(action => !retired.has(action)) }))
        .filter(item => item.Action.length);
    statements.find(item => item.Sid === "P14").Action.push("lambda:ListEventSourceMappings");
    const functions = [NAME, `${NAME}-failures`].map(name => arn("lambda", `function:${name}`));
    const failure = functions[1];
    const additions = [
        allow(["lambda:CreateFunction", "lambda:UpdateFunctionCode", "lambda:UpdateFunctionConfiguration", "lambda:PutFunctionConcurrency", "lambda:PutFunctionEventInvokeConfig",
            "lambda:InvokeFunction", "lambda:GetFunction", "lambda:GetFunctionConfiguration", "lambda:GetFunctionConcurrency", "lambda:GetFunctionEventInvokeConfig",
            "lambda:GetFunctionCodeSigningConfig", "lambda:GetPolicy", "lambda:ListVersionsByFunction", "lambda:ListTags", "lambda:TagResource"], functions),
        allow("iam:PassRole", [identityArn("runtime"), identityArn("failures")], { StringEquals: { "iam:PassedToService": "lambda.amazonaws.com" } }),
        allow(["lambda:CreateEventSourceMapping", "lambda:GetEventSourceMapping", "lambda:UpdateEventSourceMapping"], "*", { StringEquals: { "aws:RequestedRegion": REGION }, ArnEquals: { "lambda:FunctionArn": failure } }),
        // The untagged mapping uses an explicit no-default-tags provider. Listing
        // mapping metadata is read-only; CI cannot tag arbitrary existing mappings.
        allow("lambda:ListTags", arn("lambda", "event-source-mapping:*")),
        allow(["ecr:DescribeRepositories", "ecr:DescribeImages", "ecr:GetRepositoryPolicy", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], QUALIFIED_ECR_ARN),
        allow(["s3:GetObject", "s3:GetObjectVersion"], candidateResources),
        allow("codebuild:BatchGetBuilds", arn("codebuild", `project/${QUALIFIED_REPOSITORY}`)),
    ];
    return { Version: "2012-10-17", Statement: [...statements, ...additions].map(item => { const result = { ...item }; delete result.Sid; return result; }) };
}
export const legacyProductionReleasePermissions = () => releasePermissions(LEGACY_PRODUCTION_CANDIDATE_RESOURCES);
export const previousProductionReleasePermissions = () => releasePermissions(PREVIOUS_PRODUCTION_CANDIDATE_RESOURCES);
export const productionReleasePermissions = () => releasePermissions(PRODUCTION_CANDIDATE_RESOURCES);
