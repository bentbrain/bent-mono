import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify, isDeepStrictEqual as equal } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import { readRegularFile } from "./read-regular-file.mjs";
import { BOOTSTRAP_DIRECTORY, BOOTSTRAP_PRIVATE } from "./aws-personal-bootstrap.mjs";
import { privateWrite } from "./aws-personal-bootstrap-apply.mjs";
import { guardedPersonalCall, personalEnvironment, PERSONAL_ACCOUNT, PERSONAL_CONFIG_PATH } from "./aws-personal-guard.mjs";
import { personalGitHub } from "./github-personal.mjs";
import { trustCheck as check, trustEnvironments, targetPrefix, freshTime, verifyTrustGitHub } from "./repository-trust-evidence.mjs";

const exec = promisify(execFile);
const gitEnvironment = { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" };
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const sourceGit = ["-c", `safe.directory=${ROOT.replace(/\/$/, "")}`];
const PRIVATE = join(BOOTSTRAP_PRIVATE, "repository-trust");
const AWS = "registry.terraform.io/hashicorp/aws";
const PROVIDER = `provider["${AWS}"]`;
const SUB = "token.actions.githubusercontent.com:sub";
const OIDC = `arn:aws:iam::${PERSONAL_ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`;
const sha = value => createHash("sha256").update(value).digest("hex");
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => equal(canonical(a), canonical(b));
const policy = value => typeof value === "string" ? JSON.parse(value) : value;
const hasUnknown = value => value === true || value && typeof value === "object" && Object.values(value).some(hasUnknown);
export const TRUST_FILES = [".terraform.lock.hcl", "ci.tf", "state.tf", "versions.tf", "development-release-policy.json", "production.tf",
    "production-foundation-policy.json", "production-release-policy.json", "production-runtime.tf.json"].sort();
export const TRUST_INVENTORY = ["aws_iam_policy.ci_boundary", "aws_iam_role.ci", "aws_iam_role_policy.ci", "aws_kms_alias.state", "aws_kms_key.state",
    "aws_s3_bucket.state", "aws_s3_bucket_ownership_controls.state", "aws_s3_bucket_policy.state", "aws_s3_bucket_public_access_block.state",
    "aws_s3_bucket_server_side_encryption_configuration.state", "aws_s3_bucket_versioning.state", "aws_iam_policy.production_ci_boundary", "aws_iam_role.production_ci", "aws_iam_role_policy.production_ci",
    "aws_iam_policy.production_runtime_boundary", "aws_iam_policy.production_failures_boundary", "aws_iam_policy.production_invoker_boundary", "aws_iam_role.production_runtime", "aws_iam_role.production_failures",
    "aws_iam_role_policy.production_runtime", "aws_iam_role_policy.production_failures", "aws_iam_user.production_invoker", "aws_iam_user_policy.production_invoker", "data.aws_iam_openid_connect_provider.github"].sort();
const OIDC_DATA = "data.aws_iam_openid_connect_provider.github";
const MANAGED_INVENTORY = TRUST_INVENTORY.filter(name => name !== OIDC_DATA);
const address = item => `${item.mode === "data" ? "data." : ""}${item.type}.${item.name}`;
const values = state => new Map(state.resources.map(item => [address(item), item.instances[0].attributes]));
const read = path => readRegularFile(path, { privateOnly: true, maxBytes: 64 * 1024 * 1024, minBytes: 1 });
const json = async path => JSON.parse(await read(path));
const absent = async path => { try { await lstat(path); } catch (error) { if (error.code === "ENOENT") return; throw error; } throw new Error("Repository trust journal exists; preserve it and inspect state/IAM. Recovery requires a separately reviewed route."); };
const cfg = (stage, name) => protectedConfig(`trust_${stage}_${name}`);
function repositoryTrustArguments(args) {
    const [stage, operation, ...options] = args;
    check(Object.hasOwn(trustEnvironments, stage), "select development or production explicitly.");
    if (["discover", "plan"].includes(operation) && !options.length) return { stage, operation };
    const reviewPattern = stage === "development" ? /^--review=development-[A-Za-z0-9]{6}$/ : /^--review=production-[A-Za-z0-9]{6}$/;
    if (["show", "apply"].includes(operation) && options.length === 2 &&
        reviewPattern.test(options[0]) && /^--plan-sha256=[a-f0-9]{64}$/.test(options[1]))
        return { stage, operation, review: options[0].slice(9), planHash: options[1].slice(14) };
    throw new Error("Use repository-trust development|production discover|plan, or show|apply --review=<stage-ID> --plan-sha256=<hash>; no overrides.");
}
function exactTrust(value, subject) {
    const trust = policy(value), statement = trust.Statement?.[0];
    check(same(Object.keys(trust).sort(), ["Statement", "Version"]) && trust.Version === "2012-10-17" && trust.Statement?.length === 1 &&
        same(Object.keys(statement).sort(), ["Action", "Condition", "Effect", "Principal", "Sid"]) &&
        statement.Sid === `ExactPersonalRepository${subject.endsWith(":Preview") ? "Preview" : "Production"}` && statement.Effect === "Allow" &&
        statement.Action === "sts:AssumeRoleWithWebIdentity" && same(statement.Principal, { Federated: OIDC }) &&
        same(statement.Condition, { StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com", [SUB]: subject } }), "single exact provider/audience/subject trust required.");
    return trust;
}
function inspectTrustState(state, baseline) {
    check(state.version === 4 && state.terraform_version === "1.12.2" && state.lineage === baseline.original.lineage &&
        typeof state.lineage === "string" && /^[a-f0-9-]{36}$/.test(state.lineage) && Number.isSafeInteger(state.serial) && state.serial >= 0 && baseline.original.accountId === PERSONAL_ACCOUNT && baseline.original.region === "ap-southeast-2" && baseline.original.backendKey === "story-video/bootstrap/terraform.tfstate", "approved original lineage and fresh serial required.");
    check(same(state.resources?.map(address).sort(), TRUST_INVENTORY), "complete fixed bootstrap inventory.");
    for (const item of state.resources) {
        check(["managed", "data"].includes(item.mode) && !item.module && !item.each && item.provider === PROVIDER && item.instances?.length === 1 &&
            !item.instances[0].status && !item.instances[0].deposed && item.instances[0].index_key === undefined &&
            typeof item.instances[0].attributes?.id === "string" && item.instances[0].attributes.id.length > 0, "existing single untainted resource identity/provider required.");
    }
    const data = values(state).get("data.aws_iam_openid_connect_provider.github");
    check(data.id === OIDC && data.arn === OIDC && data.url === "token.actions.githubusercontent.com" && Array.isArray(data.client_id_list) &&
        data.client_id_list.some(audience => audience === "sts.amazonaws.com"), "existing read-only OIDC data ownership.");
    for (const spec of Object.values(trustEnvironments)) {
        const role = values(state).get(spec.role);
        check(role.name === spec.name && role.arn === `arn:aws:iam::${PERSONAL_ACCOUNT}:role/${spec.name}` && role.path === "/" &&
            typeof role.unique_id === "string" && role.unique_id.length > 0 && role.max_session_duration === 3600 &&
            role.permissions_boundary === `arn:aws:iam::${PERSONAL_ACCOUNT}:policy/${spec.name}-boundary`, "preserve exact CI role identity and boundary.");
    }
    return state;
}
function observedBefore(state, baseline) {
    const result = values(state);
    const seen = new Set();
    for (const item of baseline.parentObservations) {
        const childAddress = { "aws_iam_role.ci": "aws_iam_role_policy.ci", "aws_iam_role.production_ci": "aws_iam_role_policy.production_ci",
            "aws_iam_role.production_runtime": "aws_iam_role_policy.production_runtime", "aws_iam_role.production_failures": "aws_iam_role_policy.production_failures" }[item.address];
        const role = result.get(item.address), child = result.get(childAddress);
        check(child && !seen.has(item.address) && same(role.inline_policy, item.before) && item.after?.length === 1 &&
            item.after[0].name === child.name && same(policy(item.after[0].policy), policy(child.policy)), "only enumerated exact child-backed parent inline observations.");
        seen.add(item.address);
        result.set(item.address, { ...role, inline_policy: item.after });
    }
    return result;
}
// Terraform 1.12.2 saves refreshed read-only data in prior_state. It omits
// that lookup from both resource_changes and planned_values. Bind the full
// refreshed inventory and its source/provider before inspecting managed actions.
function inspectPlanBindings(plan, baseline, beforeValues) {
    const prior = plan.prior_state;
    check(prior?.format_version === "1.0" && prior.terraform_version === "1.12.2", "pinned prior-state JSON format required.");
    const inspectValues = (module, inventory, expected) => {
        check(module && !module.child_modules?.length && same(module.resources?.map(item => item.address).sort(), inventory), "exact root-module value inventory required.");
        for (const item of module.resources) {
            const raw = baseline.state.resources.find(resource => address(resource) === item.address);
            check(item.mode === raw.mode && item.type === raw.type && item.name === raw.name && item.provider_name === AWS &&
                item.schema_version === raw.instances[0].schema_version && item.index === undefined && !item.deposed &&
                same(item.values, expected.get(item.address)), "saved values must match exact refreshed/planned resource identity and content.");
        }
    };
    inspectValues(prior.values?.root_module, TRUST_INVENTORY, beforeValues);
    inspectValues(plan.planned_values?.root_module, MANAGED_INVENTORY, new Map(plan.resource_changes.map(item => [item.address, item.change.after])));
    const outputs = Object.fromEntries(Object.entries(baseline.state.outputs).map(([name, item]) => [name, { sensitive: false, ...item }]));
    check(same(prior.values.outputs, outputs) && same(plan.planned_values.outputs, outputs), "complete unchanged prior and planned outputs required.");
    const config = plan.configuration, module = config?.root_module, provider = config?.provider_config?.aws;
    check(same(Object.keys(config?.provider_config ?? {}), ["aws"]) && provider.name === "aws" && provider.full_name === AWS &&
        provider.version_constraint === "6.62.0" && !provider.alias && !provider.module_address &&
        module && !Object.keys(module.module_calls ?? {}).length && same(module.resources?.map(item => item.address).sort(), TRUST_INVENTORY), "exact root source inventory and locked AWS provider required.");
    for (const item of module.resources) {
        const raw = baseline.state.resources.find(resource => address(resource) === item.address);
        check(item.mode === raw.mode && item.type === raw.type && item.name === raw.name && item.provider_config_key === "aws" &&
            item.schema_version === raw.instances[0].schema_version && !item.count_expression && !item.for_each_expression, "single fixed source resource/provider binding required.");
        if (item.address === OIDC_DATA)
            check(same(item.expressions, { arn: { constant_value: OIDC } }), "read-only lookup must use the exact constant OIDC provider identity.");
    }
}
export function inspectRepositoryTrustPlan(plan, baseline, stage, noOp = false) {
    inspectTrustState(baseline.state, baseline);
    check(plan.format_version === "1.2" && plan.terraform_version === "1.12.2" && plan.complete === true && plan.errored === false && plan.applyable === !noOp &&
        (plan.deferred_changes === undefined || same(plan.deferred_changes, [])) && same(plan.resource_changes?.map(item => item.address).sort(), MANAGED_INVENTORY), "complete refreshed saved plan and exact inventory required.");
    const beforeValues = noOp ? values(baseline.state) : observedBefore(baseline.state, baseline);
    inspectPlanBindings(plan, baseline, beforeValues);
    const drifts = plan.resource_drift ?? [];
    check(drifts.length === (noOp ? 0 : baseline.parentObservations.length), "unknown resource drift rejected.");
    for (const drift of drifts) {
        const observed = baseline.parentObservations.find(item => item.address === drift.address);
        check(observed && drift.mode === "managed" && drift.provider_name === AWS && !drift.previous_address && !drift.change.importing &&
            same(drift.change.actions, ["update"]) && same(drift.change.before, values(baseline.state).get(drift.address)) &&
            same(drift.change.after, beforeValues.get(drift.address)) && !hasUnknown(drift.change.after_unknown), "exact reviewed child observation only.");
    }
    for (const item of plan.resource_changes) {
        const { before, after, actions, after_unknown: unknown } = item.change;
        const raw = baseline.state.resources.find(resource => address(resource) === item.address);
        check(item.provider_name === AWS && item.mode === "managed" && item.type === raw.type && item.name === raw.name && item.index === undefined && !item.previous_address &&
            !item.change.importing && !item.deposed && same(item.change.before_identity, item.change.after_identity) && !hasUnknown(unknown) && same(before, beforeValues.get(item.address)), "resolved current values, no import/move/provider/identity changes.");
        if (!noOp && item.address === trustEnvironments[stage].role) {
            const spec = trustEnvironments[stage];
            const oldTrust = exactTrust(before.assume_role_policy, `${baseline.original.subjectPrefix}:environment:${spec.environment}`);
            const next = structuredClone(oldTrust);
            next.Statement[0].Condition.StringEquals[SUB] = `${targetPrefix()}:environment:${spec.environment}`;
            exactTrust(after.assume_role_policy, `${targetPrefix()}:environment:${spec.environment}`);
            check(same(actions, ["update"]) && same(policy(after.assume_role_policy), next) &&
                same({ ...after, assume_role_policy: before.assume_role_policy }, before), "only selected role's one subject scalar may change.");
        } else check(same(actions, ["no-op"]) && same(before, after), "all other managed resources including unselected CI trust must be no-op.");
    }
    const outputs = baseline.state.outputs;
    check(same(Object.keys(plan.output_changes ?? {}).sort(), Object.keys(outputs).sort()), "complete unchanged output inventory.");
    for (const [name, item] of Object.entries(plan.output_changes))
        check(same(item.actions, ["no-op"]) && same(item.before, outputs[name].value) && same(item.after, item.before) && !hasUnknown(item.after_unknown), "outputs must remain unchanged.");
    check(plan.checks?.every(item => item.status === "pass") ?? true, "all checks must pass.");
    return { stage, changedResource: noOp ? null : trustEnvironments[stage].role, permissionsChanged: false };
}
async function renderTrustModule(directory, baseline, stage, verifyOnly = false) {
    check(/^bentbrain\/[A-Za-z0-9._-]+$/.test(protectedConfig("trustOriginalRepository")) &&
        Number.isSafeInteger(baseline.original.repositoryId) && baseline.original.repositoryId > 0 &&
        baseline.original.subjectPrefix === `repo:bentbrain@${protectedConfig("githubOwnerId")}/${protectedConfig("trustOriginalRepository").split("/")[1]}@${baseline.original.repositoryId}`,
        "exact approved original immutable subject required for private rendering.");
    check(same((await readdir(BOOTSTRAP_DIRECTORY)).filter(name => /\.tf(?:\.json)?$|\.tfvars(?:\.json)?$|\.json$|^\.terraform\.lock\.hcl$/.test(name)).sort(), TRUST_FILES), "fixed nine-file bootstrap vocabulary required.");
    const manifest = [];
    for (const name of TRUST_FILES) {
        const bytes = await readRegularFile(join(BOOTSTRAP_DIRECTORY, name));
        let resolved = resolveProtectedTemplate(bytes);
        if (name === "versions.tf") {
            const relative = 'shared_config_files      = [abspath("../../.data/aws-personal/config")]';
            check(resolved.split(relative).length === 2 && resolved.includes('version = "6.62.0"'), "exact provider source/version.");
            resolved = resolved.replace(relative, `shared_config_files      = [${JSON.stringify(PERSONAL_CONFIG_PATH)}]`);
            check(resolved.includes('required_version = ">= 1.12.0, < 2.0.0"'), "exact historical Terraform constraint.");
            resolved = resolved.replace('required_version = ">= 1.12.0, < 2.0.0"', 'required_version = "= 1.12.2"');
            check(!resolved.includes("expected_bucket_owner"), "unexpected backend owner source.");
        }
        if (stage === "development" && name === "production.tf") {
            const target = `${targetPrefix()}:environment:Production`;
            check(resolved.split(target).length === 2, "exact unselected Production subject source.");
            resolved = resolved.replace(target, `${baseline.original.subjectPrefix}:environment:Production`);
        }
        check(!resolved.includes("{{SHOP:"), "unresolved protected markers.");
        if (verifyOnly) check(sha(await read(join(directory, name))) === sha(resolved), "private rendered source changed.");
        else await privateWrite(join(directory, name), resolved);
        manifest.push({ name, sourceSha256: sha(bytes), resolvedSha256: sha(resolved) });
    }
    return manifest;
}
async function sourceEvidence() {
    const { stdout } = await exec("/usr/bin/git", [...sourceGit, "ls-files", "-z"], { cwd: ROOT, env: gitEnvironment, maxBuffer: 16 * 1024 * 1024 });
    const paths = stdout.split("\0").filter(name => name && (/^(scripts\/|\.github\/|products\/shop\/(scripts\/|infra\/|\.github\/))/.test(name) || /(^|\/)AGENTS.md$/.test(name) || ["bun.lock", "package.json", "products/shop/package.json", "SOURCE_PROVENANCE.json"].includes(name))).sort();
    const files = [];
    for (const path of paths) files.push([path, sha(await readRegularFile(join(ROOT, path)))]);
    return { files, sha256: sha(JSON.stringify(files)) };
}
async function checkout(dependencies, expected) {
    if (dependencies.inspectTrustCheckout) return dependencies.inspectTrustCheckout(expected);
    const head = (await exec("/usr/bin/git", [...sourceGit, "rev-parse", "HEAD"], { cwd: ROOT, env: gitEnvironment })).stdout.trim();
    const dirty = (await exec("/usr/bin/git", [...sourceGit, "status", "--porcelain", "--untracked-files=normal"], { cwd: ROOT, env: gitEnvironment })).stdout.trim();
    check(head === expected && !dirty, "clean exact reviewed source checkout required.");
}
function backendIdentity(backend) {
    const config = backend?.config;
    check(backend?.type === "s3" && config.bucket === `forever-tee-terraform-state-${PERSONAL_ACCOUNT}-ap-southeast-2` &&
        config.key === "story-video/bootstrap/terraform.tfstate" && config.region === "ap-southeast-2" && config.encrypt === true && config.use_lockfile === true &&
        !Object.hasOwn(config, "expected_bucket_owner") && same(config.allowed_account_ids, [PERSONAL_ACCOUNT]) &&
        config.kms_key_id === `arn:aws:kms:ap-southeast-2:${PERSONAL_ACCOUNT}:key/${protectedConfig("stateKmsKeyId")}` &&
        !config.role_arn && !config.access_key && !config.secret_key && !config.token && !config.profile && [config.assume_role, config.assume_role_with_web_identity].every(value => value == null || same(value, [])) && !config.endpoints && !config.endpoint && !config.skip_credentials_validation && !config.skip_requesting_account_id,
    "exact supported S3 backend, KMS, native lock and personal identity required; owner is attested separately.");
}
async function collectTrustPermissions(call) {
    const result = {};
    const complete = page => page?.IsTruncated === false && ["Marker", "NextToken"].every(key => !Object.hasOwn(page, key));
    for (const [key, spec] of Object.entries(trustEnvironments)) {
        const role = (await call(["iam", "get-role", "--role-name", spec.name])).Role;
        const list = await call(["iam", "list-role-policies", "--role-name", spec.name]);
        const attached = await call(["iam", "list-attached-role-policies", "--role-name", spec.name]);
        check(complete(list) && same(list.PolicyNames, [spec.inline]) && complete(attached) && same(attached.AttachedPolicies, []), "complete exact inline and empty attached policies.");
        const inline = await call(["iam", "get-role-policy", "--role-name", spec.name, "--policy-name", spec.inline]);
        const boundaryArn = `arn:aws:iam::${PERSONAL_ACCOUNT}:policy/${spec.name}-boundary`;
        const boundary = (await call(["iam", "get-policy", "--policy-arn", boundaryArn])).Policy;
        check(boundary.Arn === boundaryArn && /^v[1-9][0-9]*$/.test(boundary.DefaultVersionId), "exact boundary and current version.");
        const version = (await call(["iam", "get-policy-version", "--policy-arn", boundaryArn, "--version-id", boundary.DefaultVersionId])).PolicyVersion;
        check(version.IsDefaultVersion === true && version.VersionId === boundary.DefaultVersionId && inline.RoleName === spec.name && inline.PolicyName === spec.inline, "complete default boundary and inline document readback.");
        check(role.RoleName === spec.name && role.Arn === `arn:aws:iam::${PERSONAL_ACCOUNT}:role/${spec.name}` && role.PermissionsBoundary?.PermissionsBoundaryArn === boundaryArn &&
            role.PermissionsBoundary.PermissionsBoundaryType === "Policy", "exact live role/boundary.");
        // RoleLastUsed is telemetry, not role configuration. Retain every other
        // field including RoleId, tags, session duration and the full trust.
        const { RoleLastUsed, ...identity } = role;
        result[key] = { role: identity, inline: policy(inline.PolicyDocument), boundary: { ...boundary }, boundaryDocument: policy(version.Document) };
    }
    result.provider = await call(["iam", "get-open-id-connect-provider", "--open-id-connect-provider-arn", OIDC]);
    check(result.provider.Url === "token.actions.githubusercontent.com" && Array.isArray(result.provider.ClientIDList) &&
        result.provider.ClientIDList.some(audience => audience === "sts.amazonaws.com"), "exact live OIDC provider.");
    return result;
}
function permissionsMatchState(permissions, state) {
    const all = values(state);
    for (const [key, spec] of Object.entries(trustEnvironments)) {
        const evidence = permissions[key], role = all.get(spec.role);
        const child = all.get(spec.role.replace("aws_iam_role.", "aws_iam_role_policy."));
        const boundary = all.get(spec.role.replace("aws_iam_role.", "aws_iam_policy.") + "_boundary");
        check(role.unique_id === evidence.role.RoleId && role.arn === evidence.role.Arn && role.max_session_duration === evidence.role.MaxSessionDuration && role.path === evidence.role.Path &&
            same(policy(role.assume_role_policy), evidence.role.AssumeRolePolicyDocument) && same(policy(child.policy), evidence.inline) &&
            same(policy(boundary.policy), evidence.boundaryDocument) && boundary.arn === evidence.boundary.Arn && boundary.id === evidence.boundary.Arn,
        "full refreshed permission documents and preserved role IDs must match IAM evidence.");
    }
}
async function prerequisites(stage, privateDirectory) {
    const bytes = await read(join(privateDirectory, `${stage}-baseline.json`));
    check(sha(bytes) === cfg(stage, "baselineSha256"), "independently reviewed protected baseline hash required.");
    const baseline = JSON.parse(bytes), original = await read(join(privateDirectory, "original-repository-receipt.json"));
    check(sha(original) === protectedConfig("trustOriginalReceiptSha256") && same(JSON.parse(original), baseline.original), "original repository/lineage receipt required, never caller-guessed before trust.");
    const oldName = protectedConfig("trustOriginalRepository");
    check(/^bentbrain\/[A-Za-z0-9._-]+$/.test(oldName) && oldName !== "bentbrain/bent-mono" &&
        Number.isSafeInteger(baseline.original.repositoryId) && baseline.original.repositoryId > 0 &&
        baseline.original.repositoryId !== Number(protectedConfig("githubRepositoryId")) &&
        baseline.original.subjectPrefix === `repo:bentbrain@${protectedConfig("githubOwnerId")}/${oldName.split("/")[1]}@${baseline.original.repositoryId}` &&
        /^[a-f0-9]{40}$/.test(baseline.sourceCommit ?? "") && baseline.sourceCommit === cfg(stage, "reviewedCommit") &&
        Array.isArray(baseline.parentObservations), "explicit protected original and reviewed current source required.");
    freshTime(baseline.observedAt, Date.now());
    inspectTrustState(baseline.state, baseline);
    permissionsMatchState(baseline.permissions, baseline.state);
    for (const [key, spec] of Object.entries(trustEnvironments)) {
        const prefix = stage === "production" && key === "development" ? targetPrefix() : baseline.original.subjectPrefix;
        exactTrust(values(baseline.state).get(spec.role).assume_role_policy, `${prefix}:environment:${spec.environment}`);
    }
    if (stage === "production") {
        const journal = await json(join(privateDirectory, "development-started.json"));
        check(/^development-[A-Za-z0-9]{6}$/.test(journal.review), "prior Development journal binding required.");
        const complete = await read(join(privateDirectory, journal.review, "complete.json"));
        check(sha(complete) === cfg(stage, "developmentCompleteSha256") && JSON.parse(complete).planSha256 === journal.planSha256,
            "confirmed reviewed Development migration completion required before Production.");
        const readinessReceipts = {};
        for (const kind of ["qualification", "rollback"]) {
            const receipt = await read(join(privateDirectory, `development-${kind}-receipt.json`));
            check(sha(receipt) === baseline.developmentReadiness?.[`${kind}ReceiptSha256`] &&
                sha(receipt) === cfg(stage, `${kind}ReceiptSha256`), "exact independently reviewed Development readiness receipt bytes required.");
            readinessReceipts[kind] = JSON.parse(receipt);
        }
        const q = readinessReceipts.qualification, rollback = readinessReceipts.rollback;
        const immutable = (ref, name) => ref?.key === `source/releases/native-${protectedConfig("resource_8d0190ecec7d")}/qualification-${name}-${q.releaseId}-run-${q.qualificationRunId}.json` &&
            typeof ref.version === "string" && /^[A-Za-z0-9._~+/=-]{1,1024}$/.test(ref.version) && ref.version !== "null" && /^[a-f0-9]{64}$/.test(ref.sha256 ?? "");
        check(q.cloudQualificationVerified === true && q.applicationMutations === false && q.cleanupVerified === true && q.qualificationKind === "full" &&
            q.sourceCommit === baseline.sourceCommit && q.qualificationSourceCommit === baseline.sourceCommit &&
            q.qualificationRunId === baseline.developmentReadiness.qualificationRunId && /^native-[1-9][0-9]*$/.test(q.releaseId ?? "") &&
            /^sha256:[a-f0-9]{64}$/.test(q.imageDigest ?? "") && /^[a-f0-9-]{36}$/.test(q.workerVersionId ?? "") &&
            immutable(q.reference, "receipt") && immutable(q.cleanupReference, "cleanup-complete"),
            "established full verify-qualification result with immutable cleanup evidence required.");
        check(rollback.rollbackVerified === true && rollback.fromReleaseId === q.releaseId &&
            rollback.releaseId === `native-${baseline.developmentReadiness.rollbackRunId}` && rollback.releaseId !== rollback.fromReleaseId &&
            /^sha256:[a-f0-9]{64}$/.test(rollback.target?.imageDigest ?? "") && /^[a-f0-9]{64}$/.test(rollback.target?.sourceDigest ?? "") &&
            rollback.target?.environment === "development" && rollback.target.accountId === PERSONAL_ACCOUNT && rollback.target.region === "ap-southeast-2" &&
            rollback.target.imageUri === `${PERSONAL_ACCOUNT}.dkr.ecr.ap-southeast-2.amazonaws.com/forever-tee-video-development@${rollback.target.imageDigest}` &&
            /^[a-f0-9-]{36}$/.test(rollback.workerVersion ?? ""), "separately reviewed successful paired rollback of the freshly qualified Development pair required.");
    }
    return { baseline, baselineSha256: sha(bytes), originalReceiptSha256: sha(original) };
}
async function run(args, dependencies) {
    const request = repositoryTrustArguments(args), { stage, operation } = request;
    const privateDirectory = dependencies.trustPrivateDirectory ?? PRIVATE;
    const privateInfo = await lstat(privateDirectory);
    check(privateInfo.isDirectory() && !privateInfo.isSymbolicLink() && (privateInfo.mode & 0o077) === 0, "existing private operation root required.");
    if (operation === "discover") return discover(stage, dependencies, privateDirectory);
    // The outer CLI first requires its existing private config and tools. This
    // route neither creates those files nor supplies an alternate credential chain.
    const prerequisite = await prerequisites(stage, privateDirectory), { baseline } = prerequisite;
    const journal = join(privateDirectory, `${stage}-started.json`);
    if (operation !== "show") await absent(journal);
    await checkout(dependencies, baseline.sourceCommit);
    const source = await sourceEvidence();
    const call = async args => JSON.parse(await guardedPersonalCall(args, dependencies));
    const github = dependencies.trustGitHub ?? await personalGitHub();
    const preflight = async () => {
        await call(["sts", "get-caller-identity"]);
        check(same(await prerequisites(stage, privateDirectory), prerequisite), "private prerequisites changed.");
        await checkout(dependencies, baseline.sourceCommit);
        check(same(await sourceEvidence(), source), "source/guards/tests/workflows changed.");
        const githubEvidence = await verifyTrustGitHub(github, baseline, stage);
        const permissions = await collectTrustPermissions(call);
        check(same(permissions, baseline.permissions), "live trust/permissions/provider differ from reviewed baseline.");
        return { githubEvidence, permissions };
    };
    const evidence = await preflight();
    const object = await requireRemoteObject(call);
    check(same(object, baseline.object), "owner-attested current object differs from independently reviewed baseline.");
    const directory = operation === "plan" ? await mkdtemp(join(privateDirectory, `${stage}-`)) : join(privateDirectory, request.review);
    const directoryInfo = await lstat(directory);
    check(directoryInfo.isDirectory() && !directoryInfo.isSymbolicLink() && (directoryInfo.mode & 0o077) === 0, "private operation directory required.");
    const module = join(directory, "module"), data = join(directory, "providers");
    if (operation === "plan") await mkdir(module, { mode: 0o700 });
    for (const path of [module, ...(operation === "plan" ? [] : [data])]) {
        const info = await lstat(path);
        check(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0, "private source/provider directory required.");
    }
    const manifest = await renderTrustModule(module, baseline, stage, operation !== "plan");
    const env = { ...personalEnvironment(dependencies.environment), TF_DATA_DIR: data, TF_CLI_CONFIG_FILE: "/dev/null", TF_IN_AUTOMATION: "1",
        TF_WORKSPACE: "default", CHECKPOINT_DISABLE: "1", GOMAXPROCS: "1" };
    const owned = ownedTerraformCapture(command => dependencies.executeTerraformCapture(command, env, module), call, object);
    const capture = owned.capture;
    const version = JSON.parse(await capture(["version", "-json"]));
    check(version.terraform_version === "1.12.2", "pinned Terraform 1.12.2 executable required.");
    if (operation === "plan") {
        await privateWrite(join(directory, "source.json"), JSON.stringify(source));
        await privateWrite(join(directory, "manifest.json"), JSON.stringify(manifest));
        await privateWrite(join(directory, "prerequisites.json"), JSON.stringify(prerequisite));
        await privateWrite(join(directory, "live-before.json"), JSON.stringify(evidence));
        await privateWrite(join(directory, "init.txt"), await capture(["init", "-reconfigure", "-input=false", "-lockfile=readonly"]));
    }
    backendIdentity((await json(join(data, "terraform.tfstate"))).backend);
    const activeVersion = JSON.parse(await capture(["version", "-json"]));
    check(activeVersion.terraform_version === "1.12.2" && same(activeVersion.provider_selections, { [AWS]: "6.62.0" }), "exact locked AWS provider 6.62.0 required.");
    check((await capture(["workspace", "show"])).trim() === "default", "default workspace only.");
    const remote = await capture(["state", "pull"]);
    check(same(JSON.parse(remote), baseline.state), "fresh current full remote state differs from reviewed lineage/serial/inventory/content.");
    const path = join(directory, "trust.tfplan");
    if (operation === "plan") {
        await privateWrite(join(directory, "remote-before.tfstate"), remote);
        await privateWrite(join(directory, "plan.txt"), await capture(["plan", "-refresh=true", "-no-color", "-input=false", "-lock=true", "-lock-timeout=30s", "-parallelism=1", `-out=${path}`]));
        await chmod(path, 0o600);
    }
    const raw = await capture(["show", "-json", path]);
    const inspected = inspectRepositoryTrustPlan(JSON.parse(raw), baseline, stage), planSha256 = sha(await read(path));
    if (request.planHash) check(request.planHash === planSha256, "exact requested saved binary hash required.");
    const review = { ...inspected, sourceCommit: baseline.sourceCommit, sourceSha256: source.sha256, planSha256,
        baselineSha256: prerequisite.baselineSha256, originalReceiptSha256: prerequisite.originalReceiptSha256, stateSha256: sha(remote),
        manifest, evidence, object, requiresIndependentReview: true };
    check(same(await renderTrustModule(module, baseline, stage, true), manifest) && same(await sourceEvidence(), source), "source/rendered bytes changed during planning.");
    await owned.attest();
    if (operation === "plan") {
        await privateWrite(join(directory, "plan.json"), raw);
        await privateWrite(join(directory, "review.json"), JSON.stringify(review));
        return JSON.stringify({ reviewDirectory: directory, planSha256, sourceSha256: source.sha256, reviewSha256: sha(JSON.stringify(review)), ...inspected, requiresIndependentReview: true }) + "\n";
    }
    const saved = await read(join(directory, "review.json"));
    check(same(JSON.parse(saved), review) && same(await json(join(directory, "remote-before.tfstate")), baseline.state) &&
        same(await json(join(directory, "source.json")), source) && same(await json(join(directory, "manifest.json")), manifest) &&
        same(await json(join(directory, "prerequisites.json")), prerequisite) && same(await json(join(directory, "live-before.json")), evidence) &&
        same(JSON.parse(raw), await json(join(directory, "plan.json"))), "saved source/plan/state/evidence changed.");
    if (operation === "show") return JSON.stringify({ reviewDirectory: directory, planSha256, reviewSha256: sha(saved), ...inspected }) + "\n";
    check(cfg(stage, "approvedReviewSha256") === sha(saved) && cfg(stage, "approvedPlanSha256") === planSha256 &&
        cfg(stage, "approvedSourceSha256") === source.sha256, "separate independent approval of exact saved plan/source/review required.");
    const recheck = async () => {
        check(same(await preflight(), evidence) && same(await renderTrustModule(module, baseline, stage, true), manifest) &&
            sha(await read(path)) === planSha256 && same(JSON.parse(await capture(["state", "pull"])), baseline.state), "fresh final proof/source/binary/permissions/state checks changed.");
        backendIdentity((await json(join(data, "terraform.tfstate"))).backend);
    };
    await recheck();
    // Exclusive per-stage one-use intent. It remains after success, failure or
    // response loss. A second process cannot cross this boundary concurrently.
    await privateWrite(join(directory, "apply.tfplan"), await read(path));
    await privateWrite(journal, JSON.stringify({ review: request.review, planSha256, sourceSha256: source.sha256,
        reviewSha256: sha(saved), baselineSha256: prerequisite.baselineSha256, startedAt: new Date().toISOString() }));
    await recheck();
    check(sha(await read(join(directory, "apply.tfplan"))) === planSha256, "journal-bound saved apply bytes changed.");
    // Capture all Terraform output privately, including a failed/uncertain response.
    try {
        await privateWrite(join(directory, "apply.txt"), await capture(["apply", "-no-color", "-input=false", "-lock=true", "-lock-timeout=30s", "-parallelism=1", join(directory, "apply.tfplan")]));
    } catch (error) {
        await privateWrite(join(directory, "apply-uncertain.json"), JSON.stringify({ stdout: error.stdout ?? "", stderr: error.stderr ?? "", responseConfirmed: false }));
        throw new Error("Repository trust stopped: apply response uncertain; retain journal, inspect IAM/state through guarded reads, and obtain a separate reviewed recovery. Never replay.");
    }
    const afterRaw = await capture(["state", "pull"]);
    await privateWrite(join(directory, "remote-after.tfstate"), afterRaw);
    const after = inspectTrustState(JSON.parse(afterRaw), baseline), beforeValues = observedBefore(baseline.state, baseline), afterValues = values(after);
    check(after.serial > baseline.state.serial && same(after.outputs, baseline.state.outputs), "lineage must persist, serial must advance, outputs must stay fixed.");
    for (const [name, before] of beforeValues) {
        const actual = afterValues.get(name);
        if (name === trustEnvironments[stage].role) {
            const expected = structuredClone(policy(before.assume_role_policy));
            expected.Statement[0].Condition.StringEquals[SUB] = `${targetPrefix()}:environment:${trustEnvironments[stage].environment}`;
            check(same(policy(actual.assume_role_policy), expected) && same({ ...actual, assume_role_policy: before.assume_role_policy }, before), "confirmed selected trust-only state change required.");
        } else check(same(actual, before), "post-apply identities/permissions/unselected trust changed.");
    }
    const live = await collectTrustPermissions(call), expectedLive = structuredClone(baseline.permissions);
    expectedLive[stage].role.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals[SUB] = `${targetPrefix()}:environment:${trustEnvironments[stage].environment}`;
    check(same(live, expectedLive), "post-apply live trusts/provider/permissions changed unexpectedly.");
    permissionsMatchState(live, after);
    await privateWrite(join(directory, "live-after.json"), JSON.stringify(live));
    const noOpPath = join(directory, "after.tfplan");
    await privateWrite(join(directory, "after-plan.txt"), await capture(["plan", "-refresh=true", "-no-color", "-input=false", "-lock=true", "-lock-timeout=30s", "-parallelism=1", `-out=${noOpPath}`]));
    await chmod(noOpPath, 0o600);
    const noOp = await capture(["show", "-json", noOpPath]);
    await privateWrite(join(directory, "after-plan.json"), noOp);
    inspectRepositoryTrustPlan(JSON.parse(noOp), { ...baseline, state: after, parentObservations: [] }, stage, true);
    check(same(await sourceEvidence(), source) && sha(await read(path)) === planSha256 && sha(await read(join(directory, "apply.tfplan"))) === planSha256,
        "evidence/source changed after apply.");
    await privateWrite(join(directory, "object-after.json"), JSON.stringify(await owned.attest()));
    const complete = { stage, planSha256, sourceSha256: source.sha256, lineage: after.lineage, serial: after.serial,
        completedAt: new Date().toISOString(), refreshedNoOp: true, permissionsChanged: false, identityStorageQualificationRequired: true, releaseReady: false };
    await privateWrite(join(directory, "complete.json"), JSON.stringify(complete));
    return JSON.stringify({ evidenceDirectory: directory, completeSha256: sha(JSON.stringify(complete)), stage, refreshedNoOp: true,
        identityStorageQualificationRequired: true, releaseReady: false }) + "\n";
}
export async function runRepositoryTrust(args, dependencies) {
    try { return await run(args, dependencies); }
    catch (error) {
        if (error instanceof Error && error.message.startsWith("Repository trust stopped:")) throw new Error(error.message);
        // The CLI's general handler must never print Terraform/AWS stderr,
        // protected state, plan contents or authentication diagnostics here.
        throw new Error("Repository trust stopped: prerequisite or guarded command unavailable/uncertain. Preserve all private evidence and journals; inspect before any new action.");
    }
}
async function requireRemoteObject(call) {
    const object = await call(["s3api", "head-object", "--bucket", `forever-tee-terraform-state-${PERSONAL_ACCOUNT}-ap-southeast-2`,
        "--expected-bucket-owner", PERSONAL_ACCOUNT, "--key", "story-video/bootstrap/terraform.tfstate"]);
    check(object.ServerSideEncryption === "aws:kms" && object.SSEKMSKeyId === `arn:aws:kms:ap-southeast-2:${PERSONAL_ACCOUNT}:key/${protectedConfig("stateKmsKeyId")}` &&
        typeof object.VersionId === "string" && /^[A-Za-z0-9._~+/=-]{1,1024}$/.test(object.VersionId) && object.VersionId !== "null" &&
        Number.isSafeInteger(object.ContentLength) && object.ContentLength > 0 && typeof object.ETag === "string" && object.ETag.length > 0 &&
        typeof object.LastModified === "string" && Number.isFinite(Date.parse(object.LastModified)), "owner-attested existing versioned KMS bootstrap state object required.");
    return object;
}
// Terraform 1.12.2 has no expected-owner backend argument or request header.
// S3 itself verifies ownership on the guarded HEAD. Bind the entire versioned
// object to the approved baseline/review, and bracket each remote operation.
// Only the one-use saved apply may advance the object. Bucket deletion/recreation
// cannot preserve its S3 VersionId. The separately verified exclusive window and
// exact backend/state/permission checks remain mandatory.
function ownedTerraformCapture(capture, call, initialObject) {
    let object = initialObject;
    const attest = async () => {
        const current = await requireRemoteObject(call);
        check(same(current, object), "owner-attested state object changed before Terraform operation or evidence completion.");
        return current;
    };
    return {
        attest,
        capture: async command => {
            if (!["init", "state", "plan", "apply"].includes(command[0])) return capture(command);
            await attest();
            const result = await capture(command);
            const after = await requireRemoteObject(call);
            if (command[0] === "apply") check(after.VersionId !== object.VersionId, "saved apply must advance the owner-attested state object version.");
            else check(same(after, object), "owner-attested state object changed during Terraform operation.");
            object = after;
            return result;
        },
    };
}
async function discover(stage, dependencies, privateDirectory) {
    const journalPath = join(privateDirectory, `${stage}-started.json`);
    let journalSha256 = null;
    try { journalSha256 = sha(await read(journalPath)); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const bytes = await read(join(privateDirectory, "original-repository-receipt.json"));
    check(sha(bytes) === protectedConfig("trustOriginalReceiptSha256"), "approved original receipt required for discovery.");
    const baseline = { original: JSON.parse(bytes) }, sourceCommit = cfg(stage, "reviewedCommit");
    check(/^[a-f0-9]{40}$/.test(sourceCommit), "exact reviewed source required.");
    await checkout(dependencies, sourceCommit);
    const source = await sourceEvidence(), call = async args => JSON.parse(await guardedPersonalCall(args, dependencies));
    await call(["sts", "get-caller-identity"]);
    const object = await requireRemoteObject(call);
    const directory = await mkdtemp(join(privateDirectory, `${stage}-discovery-`));
    const module = join(directory, "module"), data = join(directory, "providers");
    await mkdir(module, { mode: 0o700 });
    const manifest = await renderTrustModule(module, baseline, stage);
    const env = { ...personalEnvironment(dependencies.environment), TF_DATA_DIR: data, TF_CLI_CONFIG_FILE: "/dev/null", TF_IN_AUTOMATION: "1", TF_WORKSPACE: "default", CHECKPOINT_DISABLE: "1", GOMAXPROCS: "1" };
    const owned = ownedTerraformCapture(command => dependencies.executeTerraformCapture(command, env, module), call, object);
    const capture = owned.capture;
    check(JSON.parse(await capture(["version", "-json"])).terraform_version === "1.12.2", "pinned Terraform executable required.");
    await privateWrite(join(directory, "init.txt"), await capture(["init", "-reconfigure", "-input=false", "-lockfile=readonly"]));
    const backend = (await json(join(data, "terraform.tfstate"))).backend;
    backendIdentity(backend);
    const version = JSON.parse(await capture(["version", "-json"]));
    check(same(version.provider_selections, { [AWS]: "6.62.0" }) && (await capture(["workspace", "show"])).trim() === "default", "pinned provider/default workspace required.");
    const raw = await capture(["state", "pull"]), state = inspectTrustState(JSON.parse(raw), baseline);
    const permissions = await collectTrustPermissions(call);
    permissionsMatchState(permissions, state);
    check(same(await sourceEvidence(), source) && same(JSON.parse(await capture(["state", "pull"])), state) &&
        same(await requireRemoteObject(call), object), "source/remote object/state changed during discovery.");
    if (journalSha256) check(sha(await read(journalPath)) === journalSha256, "started journal changed during read-only recovery discovery.");
    await privateWrite(join(directory, "remote.tfstate"), raw);
    await privateWrite(join(directory, "discovery.json"), JSON.stringify({ journalSha256, observedAt: new Date().toISOString(), sourceCommit, source, manifest,
        original: baseline.original, state, permissions, object, backend, independentBaselineReviewRequired: true }));
    return JSON.stringify({ discoveryDirectory: directory, sourceSha256: source.sha256, independentBaselineReviewRequired: true, trustChanges: false, recoveryRequired: journalSha256 !== null }) + "\n";
}
