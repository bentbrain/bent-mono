import { protectedConfig } from "./protected-config.mjs";
import { randomBytes } from "node:crypto";
export const INVOKER_USER = "forever-tee-video-development-invoker";
const names = ["STORY_VIDEO_LAMBDA_ACCESS_KEY_ID", "STORY_VIDEO_LAMBDA_SECRET_ACCESS_KEY", "STORY_VIDEO_GRANT_SECRET"];
// Tests inject offline dependencies. The executable wrapper supplies only the
// guarded personal runner and development Cloudflare client.
export async function installAppSecrets({ aws, cf, load, createRecovery, replaceRecovery }) {
    const user = await aws(["iam", "get-user", "--user-name", INVOKER_USER]);
    if (user.User?.Arn !== "arn:aws:iam::" + protectedConfig("awsAccountId") + ":user/" + (INVOKER_USER))
        throw new Error("Unexpected invoker identity.");
    const keys = await aws(["iam", "list-access-keys", "--user-name", INVOKER_USER]);
    if (!Array.isArray(keys.AccessKeyMetadata))
        throw new Error("Cannot verify development service keys.");
    const existing = await cf("/workers/scripts/forever-tee-api-development/secrets");
    if (!Array.isArray(existing))
        throw new Error("Cannot verify development Worker secrets.");
    let secrets = await load();
    if (secrets?.state === "creating") {
        throw new Error("Interrupted development key bootstrap. No keys were created or deleted on this run. Review the bootstrap journal and exact invoker key before approving orphan recovery.");
    }
    if (secrets === undefined) {
        if (keys.AccessKeyMetadata.length || existing.some(secret => names.includes(secret.name))) {
            throw new Error("Existing credentials need explicit rotation; refusing to duplicate or overwrite them.");
        }
        // Persist intent with exclusive creation and fsync BEFORE IAM. Competing
        // bootstraps cannot create another key; an uncertain result stays blocked.
        await createRecovery({ state: "creating", username: INVOKER_USER, startedAt: new Date().toISOString() });
        const result = await aws(["iam", "create-access-key", "--user-name", INVOKER_USER]);
        if (result.AccessKey?.UserName !== INVOKER_USER || result.AccessKey.Status !== "Active")
            throw new Error("Unexpected access-key owner or status.");
        secrets = { STORY_VIDEO_LAMBDA_ACCESS_KEY_ID: result.AccessKey.AccessKeyId,
            STORY_VIDEO_LAMBDA_SECRET_ACCESS_KEY: result.AccessKey.SecretAccessKey,
            STORY_VIDEO_GRANT_SECRET: randomBytes(32).toString("base64url") };
        validateSecrets(secrets);
        await replaceRecovery(secrets);
    }
    else {
        validateSecrets(secrets);
        if (keys.AccessKeyMetadata.length !== 1 || !keys.AccessKeyMetadata.some(key => key.UserName === INVOKER_USER &&
            key.Status === "Active" && key.AccessKeyId === secrets.STORY_VIDEO_LAMBDA_ACCESS_KEY_ID)) {
            throw new Error("Saved development service key is not the sole active invoker key. Review rotation before resuming.");
        }
    }
    for (const name of names) {
        await cf("/workers/scripts/forever-tee-api-development/secrets", { name, text: secrets[name], type: "secret_text" }, "PUT");
    }
}
function validateSecrets(secrets) {
    if (!secrets || typeof secrets !== "object" || Array.isArray(secrets) || Object.keys(secrets).length !== names.length ||
        names.some(name => typeof secrets[name] !== "string" || secrets[name].length < 16) ||
        !/^AKIA[A-Z0-9]{16}$/.test(secrets.STORY_VIDEO_LAMBDA_ACCESS_KEY_ID) || secrets.STORY_VIDEO_GRANT_SECRET.length < 32) {
        throw new Error("Invalid development service-key recovery data.");
    }
}
