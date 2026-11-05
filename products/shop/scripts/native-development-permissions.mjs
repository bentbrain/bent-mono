import { protectedConfig } from "./protected-config.mjs";
import { developmentCIPermissions } from "./aws-personal-bootstrap.mjs";
export function developmentReleasePermissions() {
    const account = protectedConfig("awsAccountId"), region = "ap-southeast-2", name = "forever-tee-video-development";
    const arn = (service, resource) => `arn:aws:${service}:${region}:${account}:${resource}`;
    const functions = [name, `${name}-failures`].map(value => arn("lambda", `function:${value}`));
    const source = `arn:aws:s3:::${name}-${account}-${region}`;
    const allow = (Sid, Action, Resource) => ({ Sid, Effect: "Allow", Action, Resource });
    return { Version: "2012-10-17", Statement: [...developmentCIPermissions().Statement,
            allow("DevelopmentSourceVersions", ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"], `${source}/source/*`),
            allow("InspectDevelopmentSourceBucket", ["s3:GetBucketLocation", "s3:GetBucketAcl", "s3:GetBucketVersioning", "s3:GetEncryptionConfiguration",
                "s3:GetBucketPublicAccessBlock", "s3:GetBucketPolicy", "s3:GetBucketTagging", "s3:GetBucketOwnershipControls", "s3:GetBucketCors",
                "s3:GetBucketWebsite", "s3:GetAccelerateConfiguration", "s3:GetLifecycleConfiguration", "s3:GetReplicationConfiguration", "s3:GetBucketObjectLockConfiguration"], source),
            allow("BuildDevelopmentSource", ["codebuild:StartBuild", "codebuild:StopBuild", "codebuild:BatchGetProjects"], arn("codebuild", `project/${name}`)),
            allow("InspectDevelopmentECR", ["ecr:ListTagsForResource", "ecr:GetLifecyclePolicy"], arn("ecr", `repository/${name}`)),
            allow("DeployDevelopmentImages", ["lambda:GetFunction", "lambda:GetPolicy", "lambda:ListTags", "lambda:GetFunctionCodeSigningConfig",
                "lambda:GetRuntimeManagementConfig", "lambda:UpdateFunctionCode", "lambda:UpdateFunctionConfiguration"], functions),
            allow("InspectDevelopmentFailureMapping", ["lambda:GetEventSourceMapping", "lambda:ListTags"], arn("lambda", "event-source-mapping:" + protectedConfig("resource_0bcc55046268"))),
            allow("InspectDevelopmentFailureQueues", ["sqs:GetQueueAttributes", "sqs:GetQueueUrl", "sqs:ListQueueTags"], [arn("sqs", `${name}-failures`), arn("sqs", `${name}-failures-dead-letter`)]),
            allow("InspectDevelopmentRoles", ["iam:GetRole", "iam:ListRolePolicies", "iam:GetRolePolicy", "iam:ListAttachedRolePolicies", "iam:ListRoleTags"], ["runtime", "build", "failures"].map(suffix => `arn:aws:iam::${account}:role/${name}-${suffix}`)),
            allow("InspectDevelopmentInvoker", ["iam:GetUser", "iam:ListUserPolicies", "iam:GetUserPolicy", "iam:ListAttachedUserPolicies", "iam:ListUserTags"], `arn:aws:iam::${account}:user/${name}-invoker`),
            allow("InspectDevelopmentLogTags", ["logs:ListTagsLogGroup", "logs:ListTagsForResource"], [`/aws/lambda/${name}`, `/aws/lambda/${name}-failures`, `/aws/codebuild/${name}`].flatMap(group => [arn("logs", `log-group:${group}`), arn("logs", `log-group:${group}:*`)])),
            // These read APIs do not support resource-level IAM restrictions. Requests
            // remain Sydney-only and CI queries only the named Development resources.
            { ...allow("InspectRegionalCapacityAndMetrics", ["lambda:GetAccountSettings", "logs:DescribeLogGroups", "cloudwatch:GetMetricStatistics"], "*"),
                Condition: { StringEquals: { "aws:RequestedRegion": region } } },].map((statement, index) => ({ ...statement, Sid: `D${index + 1}` })) };
}
// AWS provider 6.62.0 reads published versions during function refresh, even
// when an image update does not publish a version. No write/invoke authority.
export function developmentRefreshPermissions() {
    const policy = developmentReleasePermissions();
    const functions = policy.Statement.find(statement => statement.Action.includes("lambda:UpdateFunctionCode"));
    functions.Action.push("lambda:ListVersionsByFunction");
    return policy;
}
export function developmentBucketInspectionPermissions() {
    const policy = developmentRefreshPermissions();
    policy.Statement.find(statement => Array.isArray(statement.Action) && statement.Action.includes("s3:GetBucketAcl"))
        .Action.push("s3:ListBucket", "s3:GetBucketRequestPayment", "s3:GetBucketLogging");
    return policy;
}
export function developmentHealthProbePermissions() {
    const policy = developmentBucketInspectionPermissions();
    policy.Statement.find(statement => Array.isArray(statement.Action) && statement.Action.includes("lambda:UpdateFunctionCode"))
        .Action.push("lambda:InvokeFunction");
    return policy;
}
