import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import { createHash } from "node:crypto";
import { mkdir, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual as equal } from "node:util";
import { guardedPersonalCall, personalEnvironment } from "./aws-personal-guard.mjs";
import { privateWrite } from "./aws-personal-bootstrap-apply.mjs";
import { personalGitHub } from "./github-personal.mjs";
import { verifyProductionGitHub } from "./aws-personal-production-bootstrap.mjs";
import { productionRuntimePermissions, identityBoundaryArn, identityArn } from "./native-production-runtime-permissions.mjs";
import { bootstrapProductionInvoker, PRODUCTION_INVOKER, PRODUCTION_NATIVE_SECRET_NAMES } from "./native-production-invoker-bootstrap.mjs";
const DIRECTORY = fileURLToPath(new URL("../.data/production-invoker/", import.meta.url));
const check = (value, reason) => {
    if (!value)
        throw new Error(`Personal Production invoker stopped: ${reason}`);
};
const sha = value => createHash("sha256").update(value).digest("hex");
async function readPrivate(name) {
    const path = join(DIRECTORY, name);
    try {
        const info = await lstat(path);
        check(info.isFile() && info.size <= 16384 && (info.mode & 0o077) === 0, "private ordinary recovery files required.");
        try {
            return JSON.parse(resolveProtectedTemplate(await readFile(path)));
        }
        catch {
            throw new Error("Private Production invoker recovery data cannot be read; its contents were not logged.");
        }
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
async function writePrivate(name, value) { await privateWrite(join(DIRECTORY, name), JSON.stringify(value)); }
export async function runProductionInvoker(args, dependencies) {
    check(args.length === 1 && ["prepare", "resume"].includes(args[0]), "only exact prepare or resume; no arbitrary key operations.");
    await guardedPersonalCall(["sts", "get-caller-identity"], dependencies);
    const gh = await personalGitHub();
    await verifyProductionGitHub(gh);
    const bootstrap = JSON.parse(resolveProtectedTemplate(await readFile(new URL("../.data/terraform-video-bootstrap/production-runtime-access-AStRtp/complete.json", import.meta.url))));
    check(bootstrap.planHash === protectedConfig("resource_95e3576e88a0") && bootstrap.state?.serial === 27 &&
        bootstrap.state.managedResources === 23 && bootstrap.serviceKeysCreated === false, "verified completed identity bootstrap required.");
    await mkdir(DIRECTORY, { recursive: true, mode: 0o700 });
    const directory = await lstat(DIRECTORY);
    check(directory.isDirectory() && !directory.isSymbolicLink() && (directory.mode & 0o077) === 0, "private recovery directory required.");
    check(!await readPrivate("complete.json"), "bootstrap already completed; no repeat or rotation.");
    const iam = async (operation, version) => {
        const argumentsByOperation = {
            "get-user": ["--user-name", PRODUCTION_INVOKER], "list-access-keys": ["--user-name", PRODUCTION_INVOKER], "create-access-key": ["--user-name", PRODUCTION_INVOKER],
            "get-policy": ["--policy-arn", identityBoundaryArn("invoker")],
            "get-policy-version": ["--policy-arn", identityBoundaryArn("invoker"), "--version-id", version],
            "get-user-policy": ["--user-name", PRODUCTION_INVOKER, "--policy-name", "production-runtime"],
        };
        check(Object.hasOwn(argumentsByOperation, operation) && (operation !== "get-policy-version" || /^v[1-9][0-9]*$/.test(version)), "sealed exact invoker operation.");
        await guardedPersonalCall(["sts", "get-caller-identity"], dependencies);
        try {
            // This sealed branch runs only inside scripts/aws-personal.mjs. The raw
            // CLI allowlist is deliberately not broadened to print Production keys.
            const output = await dependencies.execute(["iam", operation, ...argumentsByOperation[operation], "--profile", "personal-dev", "--region", "ap-southeast-2",
                "--output", "json", "--no-cli-pager"], { ...personalEnvironment(dependencies.environment), AWS_MAX_ATTEMPTS: "1" });
            return JSON.parse(output);
        }
        catch {
            throw new Error("Personal Production invoker request failed or is uncertain. Preserve private recovery files; no credential output was logged.");
        }
    };
    const verifyIdentity = async () => {
        const user = (await iam("get-user")).User;
        check(user?.Arn === identityArn("invoker") && user.PermissionsBoundary?.PermissionsBoundaryArn === identityBoundaryArn("invoker"), "exact bounded invoker identity.");
        const policy = (await iam("get-policy")).Policy;
        check(policy?.Arn === identityBoundaryArn("invoker"), "exact invoker boundary.");
        const boundary = (await iam("get-policy-version", policy.DefaultVersionId)).PolicyVersion;
        const inline = await iam("get-user-policy");
        check(boundary?.IsDefaultVersion === true && equal(boundary.Document, productionRuntimePermissions("invoker")) &&
            inline.UserName === PRODUCTION_INVOKER && inline.PolicyName === "production-runtime" && equal(inline.PolicyDocument, productionRuntimePermissions("invoker")), "live invoke-only ceiling and inline policy.");
    };
    const readSecretNames = async () => {
        const response = await gh.api("/repos/bentbrain/bent-mono/environments/Production/secrets");
        check(response.total_count === response.secrets?.length, "complete secret metadata page required.");
        return response.secrets.map(secret => secret.name);
    };
    const result = await bootstrapProductionInvoker(args[0], { verifyIdentity, readKeys: () => iam("list-access-keys"), readSecretNames,
        loadIntent: () => readPrivate("intent.json"), loadCredentials: () => readPrivate("credentials.json"),
        createIntent: value => writePrivate("intent.json", value), createKey: () => iam("create-access-key"), saveCredentials: value => writePrivate("credentials.json", value),
        loadTransfer: async (name) => {
            check(PRODUCTION_NATIVE_SECRET_NAMES.includes(name), "fixed transfer name.");
            const intent = await readPrivate(`transfer-${name}.json`), credentials = await readPrivate("credentials.json");
            if (intent)
                check(intent.name === name && intent.sha256 === sha(credentials[name]), "transfer intent must match saved credentials.");
            return intent;
        },
        beginTransfer: (name, value) => writePrivate(`transfer-${name}.json`, { name, sha256: sha(value), startedAt: new Date().toISOString() }),
        setSecret: (name, value) => gh.setProductionNativeSecret(name, value),
        acknowledgeTransfer: async (name) => {
            if (!await readPrivate(`ack-${name}.json`))
                await writePrivate(`ack-${name}.json`, { name, acknowledgedAt: new Date().toISOString() });
        },
        complete: () => writePrivate("complete.json", { username: PRODUCTION_INVOKER, githubSecretsPrepared: true, cloudflareSecretsChanged: false, completedAt: new Date().toISOString() }),
    });
    return JSON.stringify(result) + "\n";
}
