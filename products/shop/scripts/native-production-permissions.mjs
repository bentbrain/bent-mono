import { protectedConfig } from "./protected-config.mjs";
// Production foundation only. No IAM mutation, image/Worker deployment,
// Development state, or SMS authority. Release permissions need a new review.
export const PRODUCTION_ACCOUNT = protectedConfig("awsAccountId");
export const PRODUCTION_REGION = "ap-southeast-2";
export const PRODUCTION_NAME = "forever-tee-video-production";
export const STATE_BUCKET = "forever-tee-terraform-state-" + protectedConfig("awsAccountId") + "-ap-southeast-2";
const PRODUCTION_STATE_KEY = "story-video/production/terraform.tfstate";
export const STATE_KMS = "arn:aws:kms:ap-southeast-2:" + protectedConfig("awsAccountId") + ":key/" + protectedConfig("stateKmsKeyId");
export const productionArn = (service, resource) => `arn:aws:${service}:${PRODUCTION_REGION}:${PRODUCTION_ACCOUNT}:${resource}`;
export const PRODUCTION_CI_ARN = `arn:aws:iam::${PRODUCTION_ACCOUNT}:role/${PRODUCTION_NAME}-ci`;
export const PRODUCTION_BOUNDARY_ARN = `arn:aws:iam::${PRODUCTION_ACCOUNT}:policy/${PRODUCTION_NAME}-ci-boundary`;
export const PRODUCTION_BUCKET = `${PRODUCTION_NAME}-${PRODUCTION_ACCOUNT}-${PRODUCTION_REGION}`;
export function productionFoundationPermissions() {
    const bucket = `arn:aws:s3:::${STATE_BUCKET}`, state = `${bucket}/${PRODUCTION_STATE_KEY}`, lock = `${state}.tflock`;
    const release = `arn:aws:s3:::${PRODUCTION_BUCKET}`;
    const allow = (Action, Resource, Condition) => ({ Effect: "Allow", Action, Resource, ...(Condition ? { Condition } : {}) });
    return { Version: "2012-10-17", Statement: [
            allow("s3:ListBucket", bucket, { StringEquals: { "s3:prefix": [PRODUCTION_STATE_KEY, `${PRODUCTION_STATE_KEY}.tflock`] } }),
            allow(["s3:GetBucketLocation", "s3:GetBucketVersioning", "s3:GetEncryptionConfiguration", "s3:GetBucketPublicAccessBlock", "s3:GetBucketPolicy"], bucket),
            allow(["s3:GetObject", "s3:PutObject"], state),
            allow(["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], lock),
            allow(["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"], STATE_KMS, { StringEquals: {
                    "kms:ViaService": `s3.${PRODUCTION_REGION}.amazonaws.com`, "kms:CallerAccount": PRODUCTION_ACCOUNT,
                    "kms:EncryptionContext:aws:s3:arn": [state, lock],
                } }),
            allow(["s3:CreateBucket", "s3:ListBucket", "s3:GetBucketLocation", "s3:GetBucketAcl", "s3:GetBucketVersioning",
                "s3:GetEncryptionConfiguration", "s3:GetBucketPublicAccessBlock", "s3:GetBucketPolicy", "s3:GetBucketTagging",
                "s3:GetBucketOwnershipControls", "s3:GetBucketCors", "s3:GetBucketWebsite", "s3:GetAccelerateConfiguration",
                "s3:GetLifecycleConfiguration", "s3:GetReplicationConfiguration", "s3:GetBucketObjectLockConfiguration",
                "s3:GetBucketRequestPayment", "s3:GetBucketLogging", "s3:PutBucketPublicAccessBlock", "s3:PutBucketVersioning",
                "s3:PutEncryptionConfiguration", "s3:PutBucketPolicy", "s3:PutBucketTagging", "s3:PutBucketOwnershipControls"], release),
            allow(["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"], `${release}/source/*`),
            allow(["sqs:CreateQueue", "sqs:GetQueueAttributes", "sqs:GetQueueUrl", "sqs:ListQueueTags", "sqs:SetQueueAttributes", "sqs:TagQueue"], [productionArn("sqs", `${PRODUCTION_NAME}-failures`), productionArn("sqs", `${PRODUCTION_NAME}-failures-dead-letter`)]),
            allow(["logs:CreateLogGroup", "logs:PutRetentionPolicy", "logs:ListTagsForResource", "logs:ListTagsLogGroup", "logs:TagResource", "logs:TagLogGroup"], [PRODUCTION_NAME, `${PRODUCTION_NAME}-failures`].flatMap(name => [productionArn("logs", `log-group:/aws/lambda/${name}`), productionArn("logs", `log-group:/aws/lambda/${name}:*`)])),
            allow(["sns:CreateTopic", "sns:GetTopicAttributes", "sns:SetTopicAttributes", "sns:ListTagsForResource", "sns:TagResource", "sns:ListSubscriptionsByTopic", "sns:Publish"], productionArn("sns", `${PRODUCTION_NAME}-alerts`)),
            allow("sns:Subscribe", productionArn("sns", `${PRODUCTION_NAME}-alerts`), { StringEquals: { "sns:Protocol": "email" } }),
            allow(["sns:GetSubscriptionAttributes"], `${productionArn("sns", `${PRODUCTION_NAME}-alerts`)}:*`),
            allow(["cloudwatch:PutMetricAlarm", "cloudwatch:DescribeAlarms", "cloudwatch:ListTagsForResource", "cloudwatch:TagResource"], productionArn("cloudwatch", `alarm:${PRODUCTION_NAME}-*`)),
            // These read APIs have no resource-level IAM support. They remain regional.
            allow(["lambda:GetAccountSettings", "logs:DescribeLogGroups", "cloudwatch:GetMetricStatistics"], "*", { StringEquals: { "aws:RequestedRegion": PRODUCTION_REGION } }),
        ].map((statement, i) => ({ Sid: `P${i + 1}`, ...statement })) };
}
// SNS authorizes GetSubscriptionAttributes against the parent topic, not the
// subscription ARN. Preserve the original generator for consumed plan evidence.
export function productionAlertReadPermissions() {
    const policy = productionFoundationPermissions();
    policy.Statement.find(item => item.Sid === "P12").Resource = productionArn("sns", `${PRODUCTION_NAME}-alerts`);
    return policy;
}
export function productionTrust() {
    return { Version: "2012-10-17", Statement: [{ Sid: "ExactPersonalRepositoryProduction", Effect: "Allow", Action: "sts:AssumeRoleWithWebIdentity",
                Principal: { Federated: `arn:aws:iam::${PRODUCTION_ACCOUNT}:oidc-provider/token.actions.githubusercontent.com` },
                Condition: { StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                        "token.actions.githubusercontent.com:sub": "repo:bentbrain@" + protectedConfig("githubOwnerId") + "/bent-mono@" + protectedConfig("githubRepositoryId") + ":environment:Production" } } }] };
}
export function productionStateStatements() {
    const state = `arn:aws:s3:::${STATE_BUCKET}/${PRODUCTION_STATE_KEY}`;
    return [
        { Sid: "RetainProductionStateVersions", Effect: "Deny", Principal: "*", Action: ["s3:DeleteObject", "s3:DeleteObjectVersion"], Resource: state },
        { Sid: "ProductionCICannotAccessOtherState", Effect: "Deny", Principal: "*",
            Action: ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion"],
            NotResource: [state, `${state}.tflock`], Condition: { ArnEquals: { "aws:PrincipalArn": PRODUCTION_CI_ARN } } },
    ];
}
