import { randomBytes } from "node:crypto";

export const PRODUCTION_NATIVE_SECRET_NAMES = ["STORY_VIDEO_LAMBDA_ACCESS_KEY_ID", "STORY_VIDEO_LAMBDA_SECRET_ACCESS_KEY", "STORY_VIDEO_GRANT_SECRET"];
export const PRODUCTION_INVOKER = "forever-tee-video-production-invoker";
const check = (value, reason) => { if (!value) throw new Error(`Production invoker bootstrap stopped: ${reason}`); };
export function validateProductionNativeSecrets(value) {
  check(value && Object.keys(value).sort().join() === [...PRODUCTION_NATIVE_SECRET_NAMES].sort().join() &&
    /^AKIA[A-Z0-9]{16}$/.test(value.STORY_VIDEO_LAMBDA_ACCESS_KEY_ID) && /^[A-Za-z0-9+/]{40}$/.test(value.STORY_VIDEO_LAMBDA_SECRET_ACCESS_KEY) &&
    /^[A-Za-z0-9_-]{43}$/.test(value.STORY_VIDEO_GRANT_SECRET), "valid complete service-key recovery data required.");
}

// The executable supplies only the sealed personal runner and verified personal
// GitHub client. Nothing here installs or deploys a Cloudflare Worker.
export async function bootstrapProductionInvoker(phase, dependencies) {
  check(["prepare", "resume"].includes(phase), "explicit prepare or resume required.");
  const { verifyIdentity, readKeys, readSecretNames, loadIntent, loadCredentials, createIntent, createKey, saveCredentials,
    loadTransfer, beginTransfer, setSecret, acknowledgeTransfer, complete } = dependencies;
  await verifyIdentity();
  let keys = await readKeys();
  check(Array.isArray(keys.AccessKeyMetadata) && !keys.IsTruncated && !keys.Marker, "complete exact invoker key inventory.");
  const existing = await readSecretNames();
  check(Array.isArray(existing), "complete Production secret metadata.");
  const intent = await loadIntent();
  let secrets = await loadCredentials();
  if (phase === "prepare") {
    check(!intent && !secrets && keys.AccessKeyMetadata.length === 0 && !existing.some(name => PRODUCTION_NATIVE_SECRET_NAMES.includes(name)),
      "fresh bootstrap requires no existing keys, journal or native secrets. No rotation or takeover.");
    await createIntent({ username: PRODUCTION_INVOKER, state: "creating", startedAt: new Date().toISOString() });
    const response = await createKey(), key = response.AccessKey;
    check(key?.UserName === PRODUCTION_INVOKER && key.Status === "Active", "exact created key owner/status.");
    secrets = { STORY_VIDEO_LAMBDA_ACCESS_KEY_ID: key.AccessKeyId, STORY_VIDEO_LAMBDA_SECRET_ACCESS_KEY: key.SecretAccessKey,
      STORY_VIDEO_GRANT_SECRET: randomBytes(32).toString("base64url") };
    validateProductionNativeSecrets(secrets);
    await saveCredentials(secrets);
    keys = await readKeys();
  } else {
    check(intent?.username === PRODUCTION_INVOKER && intent.state === "creating" && typeof intent.startedAt === "string" && secrets,
      "interrupted creation without a complete saved key needs review; never create a replacement automatically.");
    validateProductionNativeSecrets(secrets);
  }
  check(!keys.IsTruncated && !keys.Marker && Array.isArray(keys.AccessKeyMetadata) && keys.AccessKeyMetadata.length === 1 && keys.AccessKeyMetadata[0].UserName === PRODUCTION_INVOKER &&
    keys.AccessKeyMetadata[0].Status === "Active" && keys.AccessKeyMetadata[0].AccessKeyId === secrets.STORY_VIDEO_LAMBDA_ACCESS_KEY_ID,
  "saved key must be the invoker's sole active key.");
  for (const name of PRODUCTION_NATIVE_SECRET_NAMES) {
    const owned = await loadTransfer(name);
    check(!existing.includes(name) || owned, "existing GitHub secret lacks this bootstrap's write intent.");
    if (!owned) await beginTransfer(name, secrets[name]);
    // Resume repeats the same value only for this bootstrap's fixed, journaled
    // destination. It never creates another AWS key or changes unrelated secrets.
    await setSecret(name, secrets[name]);
    await acknowledgeTransfer(name);
  }
  const installed = await readSecretNames();
  check(PRODUCTION_NATIVE_SECRET_NAMES.every(name => installed.includes(name)), "all protected GitHub secret names must exist after transfer.");
  await complete();
  return { environment: "production", invokeOnlyIdentity: PRODUCTION_INVOKER, githubSecretsPrepared: true, cloudflareSecretsChanged: false, applicationDeployment: false };
}
