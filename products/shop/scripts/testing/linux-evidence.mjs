import assert from "node:assert/strict";
import { constants, createHash, createPrivateKey, createPublicKey, privateDecrypt, publicEncrypt, randomBytes } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { readRegularFile } from "../read-regular-file.mjs";
import { openReleaseArchive, sealReleaseArchive } from "../release-evidence.mjs";

const canonical = value => value && typeof value === "object"
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  : JSON.stringify(value);
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const fail = () => new Error("Linux evidence authentication failed; use the original run identity and local recipient private key.");

function identity(value) {
  assert.ok(exactKeys(value, ["sourceCommit", "runId", "filename"]));
  assert.match(value.sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(String(value.runId), /^[1-9][0-9]*$/);
  assert.match(value.filename, /^[a-z][a-z0-9-]*\.json$/);
  return { repository: "bentbrain/bent-mono", sourceCommit: value.sourceCommit, runId: String(value.runId), filename: value.filename };
}
function fingerprint(key) {
  assert.equal(key.asymmetricKeyType, "rsa");
  assert.ok(key.asymmetricKeyDetails.modulusLength >= 3072, "RSA recipient must have at least 3072 bits");
  return createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
}
function publicRecipient(value) {
  assert.ok(exactKeys(value, ["publicKeyPem", "keyFingerprint"]) || exactKeys(value, ["schema", "algorithm", "publicKeyPem", "spkiSha256"]));
  if (Object.hasOwn(value, "schema")) {
    assert.equal(value.schema, "shop.linux-evidence-recipient/v1");
    assert.equal(value.algorithm, "RSA-OAEP-SHA256");
  }
  assert.match(value.publicKeyPem, /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/);
  const keyFingerprint = Object.hasOwn(value, "schema") ? value.spkiSha256 : value.keyFingerprint;
  assert.match(keyFingerprint, /^[a-f0-9]{64}$/);
  const key = createPublicKey(value.publicKeyPem);
  assert.equal(fingerprint(key), keyFingerprint);
  return { key, keyFingerprint };
}
function oaep(key, bound, keyFingerprint) {
  return { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256", oaepLabel: Buffer.from(canonical({ identity: bound, keyFingerprint })) };
}
function ephemeralEnvironment(session) {
  return { SHOP_EVIDENCE_KEY_VERSION: "v1", SHOP_EVIDENCE_ENCRYPTION_KEY: session.toString("hex") };
}

// The runner receives only the public recipient. Each archive gets a new AES key.
export async function sealLinuxEvidence(source, output, suppliedIdentity, recipient) {
  let session, env, created = false;
  try {
    const { key, keyFingerprint } = publicRecipient(recipient), bound = identity(suppliedIdentity);
    session = randomBytes(32); env = ephemeralEnvironment(session);
    const wrappedKey = publicEncrypt(oaep(key, bound, keyFingerprint), session).toString("base64");
    await sealReleaseArchive(source, output, suppliedIdentity, env); created = true;
    await writeFile(`${output}.envelope.json`, JSON.stringify({ schema: "shop.linux-evidence-envelope/v1", algorithm: "RSA-OAEP-SHA256",
      keyFingerprint, identity: bound, wrappedKey }) + "\n", { flag: "wx", mode: 0o600 });
  } catch {
    if (created) { await rm(output, { force: true }); await rm(`${output}.json`, { force: true }); }
    throw new Error("Linux evidence could not be sealed; upload only the encrypted archive and its recipient envelope.");
  } finally { session?.fill(0); if (env) env.SHOP_EVIDENCE_ENCRYPTION_KEY = ""; }
}

// Run locally with the private key retained outside the repository and runner.
export async function openLinuxEvidence(source, output, suppliedIdentity, { privateKeyPem, keyFingerprint }) {
  let session, env;
  try {
    const bound = identity(suppliedIdentity);
    assert.match(keyFingerprint, /^[a-f0-9]{64}$/);
    const privateKey = createPrivateKey(privateKeyPem), publicKey = createPublicKey(privateKey);
    assert.equal(fingerprint(publicKey), keyFingerprint);
    const envelope = JSON.parse((await readRegularFile(`${source}.envelope.json`, { minBytes: 1, maxBytes: 16384 })).toString("utf8"));
    assert.ok(exactKeys(envelope, ["schema", "algorithm", "keyFingerprint", "identity", "wrappedKey"]));
    assert.equal(envelope.schema, "shop.linux-evidence-envelope/v1");
    assert.equal(envelope.algorithm, "RSA-OAEP-SHA256");
    assert.equal(envelope.keyFingerprint, keyFingerprint);
    assert.equal(canonical(envelope.identity), canonical(bound));
    assert.equal(typeof envelope.wrappedKey, "string");
    const wrapped = Buffer.from(envelope.wrappedKey, "base64");
    assert.equal(wrapped.toString("base64"), envelope.wrappedKey);
    assert.equal(wrapped.length, privateKey.asymmetricKeyDetails.modulusLength / 8);
    session = privateDecrypt(oaep(privateKey, bound, keyFingerprint), wrapped);
    assert.equal(session.length, 32); env = ephemeralEnvironment(session);
    await openReleaseArchive(source, output, suppliedIdentity, env);
  } catch { throw fail(); }
  finally { session?.fill(0); if (env) env.SHOP_EVIDENCE_ENCRYPTION_KEY = ""; }
}
