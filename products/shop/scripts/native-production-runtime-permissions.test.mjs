import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { productionReleasePermissions, productionRuntimePermissions, productionRuntimeTerraform, productionRuntimeTrust, identityName, identityArn, identityBoundaryArn, QUALIFIED_ECR_ARN, RUNTIME_IDENTITIES } from "./native-production-runtime-permissions.mjs";
const actions = item => [item.Action].flat();
test("checked-in runtime identities and release policy match the reviewed generator", async () => {
    const directory = new URL("../infra/story-video-development-bootstrap/", import.meta.url);
    assert.deepEqual(JSON.parse(resolveProtectedTemplate(await readFile(new URL("production-runtime.tf.json", directory)))), productionRuntimeTerraform());
    assert.deepEqual(JSON.parse(resolveProtectedTemplate(await readFile(new URL("production-release-policy.json", directory)))), productionReleasePermissions());
});
test("Production runtime identities have independent boundaries and no storage or IAM access", () => {
    for (const kind of RUNTIME_IDENTITIES) {
        const policy = productionRuntimePermissions(kind);
        assert.ok(JSON.stringify(policy).length < 6144);
        for (const item of policy.Statement) {
            assert.equal(item.Effect, "Allow");
            assert.ok(actions(item).every(action => !/^(iam:|sts:|s3:)/.test(action)));
            assert.ok(!JSON.stringify(item).includes("*") || actions(item).every(action => action.startsWith("logs:")));
        }
        if (kind === "invoker")
            assert.deepEqual(policy.Statement, [{ Effect: "Allow", Action: "lambda:InvokeFunction",
                    Resource: "arn:aws:lambda:ap-southeast-2:" + protectedConfig("awsAccountId") + ":function:forever-tee-video-production" }]);
        else {
            const ecr = policy.Statement.find(item => actions(item).includes("ecr:BatchGetImage"));
            assert.equal(ecr.Resource, QUALIFIED_ECR_ARN);
            assert.deepEqual(actions(ecr), ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]);
            assert.ok(policy.Statement.filter(item => item !== ecr).every(item => !JSON.stringify(item.Resource).includes("development")));
        }
    }
    assert.throws(() => identityName("ci"));
    assert.throws(() => productionRuntimePermissions("development"));
});
test("runtime Terraform declares exactly nine protected identities/policies and never service keys", () => {
    const module = productionRuntimeTerraform();
    assert.equal(Object.values(module.resource).flatMap(resources => Object.values(resources)).length, 9);
    assert.equal(module.resource.aws_iam_access_key, undefined);
    for (const kind of RUNTIME_IDENTITIES) {
        const key = `production_${kind}`;
        const boundary = module.resource.aws_iam_policy[`${key}_boundary`];
        const identity = module.resource[kind === "invoker" ? "aws_iam_user" : "aws_iam_role"][key];
        const inline = module.resource[kind === "invoker" ? "aws_iam_user_policy" : "aws_iam_role_policy"][key];
        assert.equal(identity.name, identityName(kind));
        assert.equal(identity.permissions_boundary, identityBoundaryArn(kind));
        assert.deepEqual(JSON.parse(boundary.policy), productionRuntimePermissions(kind));
        assert.equal(inline.policy, boundary.policy);
        assert.ok([boundary, identity, inline].every(item => item.lifecycle.prevent_destroy));
        if (kind === "invoker")
            assert.equal(identity.force_destroy, false);
        else
            assert.deepEqual(JSON.parse(identity.assume_role_policy), productionRuntimeTrust());
    }
});
test("release ceiling keeps exact state/evidence access and retires foundation creation writes", () => {
    const policy = productionReleasePermissions();
    assert.ok(JSON.stringify(policy).length <= 6144);
    for (const item of policy.Statement) {
        assert.equal(item.Effect, "Allow");
        for (const action of actions(item)) {
            assert.ok(!["s3:CreateBucket", "s3:PutBucketPolicy", "sns:Subscribe", "sns:SetTopicAttributes", "sqs:CreateQueue", "sqs:SetQueueAttributes",
                "ecr:SetRepositoryPolicy", "ecr:PutImage", "ecr:GetAuthorizationToken", "codebuild:StartBuild", "lambda:AddPermission", "lambda:CreateFunctionUrlConfig"].includes(action));
            if (action.startsWith("iam:")) {
                assert.equal(action, "iam:PassRole");
                assert.deepEqual(item.Resource, [identityArn("runtime"), identityArn("failures")]);
                assert.deepEqual(item.Condition, { StringEquals: { "iam:PassedToService": "lambda.amazonaws.com" } });
            }
            if (action.includes("Delete"))
                assert.ok(action === "s3:DeleteObject" && item.Resource.endsWith("production/terraform.tfstate.tflock"));
            if (JSON.stringify(item.Resource).includes("development"))
                assert.ok(["s3:GetObject", "s3:GetObjectVersion", "codebuild:BatchGetBuilds",
                    "ecr:DescribeImages", "ecr:DescribeRepositories", "ecr:GetRepositoryPolicy", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"].includes(action));
            if (item.Resource === "*" && !["lambda:GetAccountSettings", "lambda:ListEventSourceMappings", "logs:DescribeLogGroups", "cloudwatch:GetMetricStatistics"].includes(action)) {
                assert.ok(["lambda:CreateEventSourceMapping", "lambda:GetEventSourceMapping", "lambda:UpdateEventSourceMapping"].includes(action));
                assert.equal(item.Condition.ArnEquals["lambda:FunctionArn"], "arn:aws:lambda:ap-southeast-2:" + protectedConfig("awsAccountId") + ":function:forever-tee-video-production-failures");
            }
        }
    }
    const readSubscription = policy.Statement.find(item => actions(item).includes("sns:GetSubscriptionAttributes"));
    assert.equal(readSubscription.Resource, "arn:aws:sns:ap-southeast-2:" + protectedConfig("awsAccountId") + ":forever-tee-video-production-alerts");
    assert.ok(!JSON.stringify(policy).includes("story-video/development/terraform.tfstate"));
    assert.ok(!JSON.stringify(policy).includes("story-video/bootstrap/terraform.tfstate"));
});
