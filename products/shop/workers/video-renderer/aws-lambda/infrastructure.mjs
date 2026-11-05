import { ACCOUNT, BUCKET, FUNCTION_ARN, NAME, REGION, REPOSITORY, RESERVED_CONCURRENCY } from "./config.mjs";

const ref = (name) => ({ Ref: name });
const attr = (name, attribute) => ({ "Fn::GetAtt": [name, attribute] });
const policy = (Statement) => ({ Version: "2012-10-17", Statement });
const allow = (Action, Resource) => ({ Effect: "Allow", Action, Resource });
const logsArn = (group) => `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:${group}:*`;
const logGroup = (name) => ({ Type: "AWS::Logs::LogGroup", Properties: { LogGroupName: name, RetentionInDays: 7 } });

export function infrastructure() {
  const repositoryArn = `arn:aws:ecr:${REGION}:${ACCOUNT}:repository/${NAME}`;
  const buildGroup = `/aws/codebuild/${NAME}`;
  const lambdaGroup = `/aws/lambda/${NAME}`;
  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: "Private personal-account story video benchmark. No storefront integration.",
    Parameters: {
      SourceDigest: { Type: "String", AllowedPattern: "[0-9a-f]{64}" },
      ImageDigest: { Type: "String", Default: "", AllowedPattern: "^$|^sha256:[0-9a-f]{64}$" },
      MemoryMB: { Type: "Number", Default: 8192, AllowedValues: [3008, 4096, 6144, 8192, 10240] },
      CapacityMode: { Type: "String", Default: "reserved-eight", AllowedValues: ["reserved-eight", "sequential-smoke"] },
    },
    Rules: { PersonalAccountOnly: { Assertions: [
      { Assert: { "Fn::Equals": [ref("AWS::AccountId"), ACCOUNT] }, AssertDescription: "Personal account only." },
      { Assert: { "Fn::Equals": [ref("AWS::Region"), REGION] }, AssertDescription: "Sydney only." },
    ] } },
    Conditions: {
      HasImage: { "Fn::Not": [{ "Fn::Equals": [ref("ImageDigest"), ""] }] },
      ReserveCapacity: { "Fn::Equals": [ref("CapacityMode"), "reserved-eight"] },
    },
    Resources: {
      Bucket: {
        Type: "AWS::S3::Bucket", DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain",
        Properties: {
          BucketName: BUCKET, VersioningConfiguration: { Status: "Enabled" },
          PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
          OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] },
          BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] },
          LifecycleConfiguration: { Rules: [{ Id: "ExpireBenchmarkOutputs", Status: "Enabled", Prefix: "outputs/",
            ExpirationInDays: 7, NoncurrentVersionExpiration: { NoncurrentDays: 7 },
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }] },
        },
      },
      BucketPolicy: { Type: "AWS::S3::BucketPolicy", Properties: {
        Bucket: ref("Bucket"), PolicyDocument: policy([{
          Effect: "Deny", Principal: "*", Action: "s3:*", Resource: [`arn:aws:s3:::${BUCKET}`, `arn:aws:s3:::${BUCKET}/*`],
          Condition: { Bool: { "aws:SecureTransport": "false" } },
        }]),
      } },
      Repository: { Type: "AWS::ECR::Repository", DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain", Properties: {
        RepositoryName: NAME, ImageTagMutability: "IMMUTABLE", ImageScanningConfiguration: { ScanOnPush: true },
        RepositoryPolicyText: policy([{
          Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" },
          Action: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
          Condition: { ArnLike: { "aws:SourceArn": FUNCTION_ARN } },
        }]),
      } },
      BuildLogs: logGroup(buildGroup),
      BuildRole: { Type: "AWS::IAM::Role", Properties: {
        RoleName: `${NAME}-build`,
        AssumeRolePolicyDocument: policy([{
          Effect: "Allow", Principal: { Service: "codebuild.amazonaws.com" }, Action: "sts:AssumeRole",
          Condition: { StringEquals: { "aws:SourceAccount": ACCOUNT },
            ArnEquals: { "aws:SourceArn": `arn:aws:codebuild:${REGION}:${ACCOUNT}:project/${NAME}` } },
        }]),
        Policies: [{ PolicyName: "IsolatedImageBuild", PolicyDocument: policy([
          allow(["s3:GetObject", "s3:GetObjectVersion"], `arn:aws:s3:::${BUCKET}/source/*`),
          allow(["s3:GetBucketLocation", "s3:GetBucketAcl"], `arn:aws:s3:::${BUCKET}`),
          allow("ecr:GetAuthorizationToken", "*"),
          allow(["ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
            "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:DescribeImages"], repositoryArn),
          allow(["logs:CreateLogStream", "logs:PutLogEvents"], logsArn(buildGroup)),
        ]) }],
      } },
      Build: { Type: "AWS::CodeBuild::Project", DependsOn: ["BuildLogs", "Repository"], Properties: {
        Name: NAME, ServiceRole: attr("BuildRole", "Arn"), TimeoutInMinutes: 20, QueuedTimeoutInMinutes: 5,
        ConcurrentBuildLimit: 1, Artifacts: { Type: "NO_ARTIFACTS" },
        Source: { Type: "S3", Location: { "Fn::Join": ["", [BUCKET, "/source/", ref("SourceDigest"), ".zip"]] },
          BuildSpec: JSON.stringify({ version: "0.2", phases: { build: { commands: ["bash aws-lambda/cloud-build.sh"] } } }) },
        Environment: { Type: "LINUX_CONTAINER", ComputeType: "BUILD_GENERAL1_SMALL", Image: "aws/codebuild/standard:7.0", PrivilegedMode: true,
          EnvironmentVariables: [{ Name: "SOURCE_DIGEST", Value: ref("SourceDigest") }, { Name: "SHOP_AWS_ACCOUNT_ID", Value: ACCOUNT }] },
        LogsConfig: { CloudWatchLogs: { Status: "ENABLED", GroupName: buildGroup } },
      } },
      RenderLogs: { ...logGroup(lambdaGroup), Condition: "HasImage" },
      RenderRole: { Type: "AWS::IAM::Role", Condition: "HasImage", Properties: {
        RoleName: `${NAME}-render`,
        AssumeRolePolicyDocument: policy([{
          Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole",
        }]),
        Policies: [{ PolicyName: "PrivateBenchmarkAssetsOnly", PolicyDocument: policy([
          allow("s3:GetObject", `arn:aws:s3:::${BUCKET}/inputs/*`),
          allow("s3:PutObject", `arn:aws:s3:::${BUCKET}/outputs/*`),
          allow(["logs:CreateLogStream", "logs:PutLogEvents"], logsArn(lambdaGroup)),
        ]) }],
      } },
      Function: { Type: "AWS::Lambda::Function", Condition: "HasImage", DependsOn: "RenderLogs", Properties: {
        FunctionName: NAME, PackageType: "Image", Architectures: ["x86_64"],
        Code: { ImageUri: { "Fn::Join": ["", [REPOSITORY, "@", ref("ImageDigest")]] } },
        Role: attr("RenderRole", "Arn"), MemorySize: ref("MemoryMB"), Timeout: 120,
        EphemeralStorage: { Size: 1024 },
        ReservedConcurrentExecutions: { "Fn::If": ["ReserveCapacity", RESERVED_CONCURRENCY, ref("AWS::NoValue")] },
        Environment: { Variables: { STORY_BUCKET: BUCKET, STORY_BUILD_ID: ref("SourceDigest"), STORY_CAPACITY_MODE: ref("CapacityMode") } },
      } },
    },
    Outputs: {
      BucketName: { Value: ref("Bucket") }, RepositoryUri: { Value: REPOSITORY }, BuildProject: { Value: ref("Build") },
      FunctionArn: { Condition: "HasImage", Value: attr("Function", "Arn") },
    },
  };
}
