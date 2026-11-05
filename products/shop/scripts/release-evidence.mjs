import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, rm, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { readRegularFile } from "./read-regular-file.mjs";

function keyring(env) {
  const version = env.SHOP_EVIDENCE_KEY_VERSION;
  if (!/^v[1-9][0-9]{0,5}$/.test(version ?? "")) throw new Error("Protected Shop evidence key version is required.");
  const keys = new Map([[version, env.SHOP_EVIDENCE_ENCRYPTION_KEY]]);
  if (env.SHOP_EVIDENCE_PREVIOUS_KEYS_JSON) {
    const previous = JSON.parse(env.SHOP_EVIDENCE_PREVIOUS_KEYS_JSON);
    if (!previous || typeof previous !== "object" || Array.isArray(previous) || Object.keys(previous).length > 8) throw new Error("Invalid protected evidence keyring.");
    for (const [name, value] of Object.entries(previous)) {
      if (!/^v[1-9][0-9]{0,5}$/.test(name) || keys.has(name)) throw new Error("Ambiguous protected evidence key version.");
      keys.set(name, value);
    }
  }
  for (const [name, value] of keys) {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
      throw new Error("Every protected Shop evidence key must contain exactly 64 lowercase hex characters.");
    }
    keys.set(name, Buffer.from(value, "hex"));
  }
  return { version, keys };
}
function context({ sourceCommit, runId, filename }) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? "") || !/^[1-9][0-9]*$/.test(String(runId)) || !/^[a-z][a-z0-9-]*\.json$/.test(filename ?? "")) {
    throw new Error("Exact Shop evidence source, run and filename are required.");
  }
  return { repository: "bentbrain/bent-mono", sourceCommit, runId: String(runId), filename };
}
export function sealReleaseEvidence(value, identity, env = process.env) {
  const { version, keys } = keyring(env), bound = context(identity);
  const header = { schemaVersion: 1, keyVersion: version, ...bound };
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", keys.get(version), nonce);
  cipher.setAAD(Buffer.from(JSON.stringify(header)));
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > 4 * 1024 * 1024) throw new Error("Shop evidence pointer exceeds its bound.");
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return JSON.stringify({ ...header, nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") });
}
export function openReleaseEvidence(encoded, identity, env = process.env) {
  try {
    if (Buffer.byteLength(encoded) > 6 * 1024 * 1024) throw new Error();
    const value = JSON.parse(encoded), bound = context(identity), { keys } = keyring(env);
    if (Object.keys(value).sort().join() !== ["schemaVersion", "keyVersion", "repository", "sourceCommit", "runId", "filename", "nonce", "ciphertext", "tag"].sort().join() || value.schemaVersion !== 1 || !keys.has(value.keyVersion)) throw new Error();
    for (const [name, expected] of Object.entries(bound)) if (value[name] !== expected) throw new Error();
    const decode = (name, size) => {
      if (typeof value[name] !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value[name])) throw new Error();
      const bytes = Buffer.from(value[name], "base64");
      if (bytes.toString("base64") !== value[name] || size && bytes.length !== size) throw new Error();
      return bytes;
    };
    const header = { schemaVersion: 1, keyVersion: value.keyVersion, ...bound };
    const decipher = createDecipheriv("aes-256-gcm", keys.get(value.keyVersion), decode("nonce", 12));
    decipher.setAAD(Buffer.from(JSON.stringify(header)));
    decipher.setAuthTag(decode("tag", 16));
    const bytes = Buffer.concat([decipher.update(decode("ciphertext")), decipher.final()]);
    if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new Error();
    return JSON.parse(bytes.toString("utf8"));
  } catch { throw new Error("Shop evidence authentication failed; inspect the protected key version and original run."); }
}

// Browser trace archives can be large and contain headers, cookies and binary
// attachments. Stream every byte; pointer limits do not apply to diagnostics.
export async function sealReleaseArchive(source, output, identity, env = process.env) {
  const { version, keys } = keyring(env), nonce = randomBytes(12);
  const header = { schemaVersion: 1, format: "aes-256-gcm-stream-v1", keyVersion: version, ...context(identity), nonce: nonce.toString("base64") };
  let inputHandle, outputHandle, created = false;
  try {
    inputHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await inputHandle.stat()).isFile()) throw new Error();
    outputHandle = await open(output, "wx", 0o600); created = true;
    const cipher = createCipheriv("aes-256-gcm", keys.get(version), nonce);
    cipher.setAAD(Buffer.from(JSON.stringify(header)));
    await pipeline(inputHandle.createReadStream(), cipher, outputHandle.createWriteStream());
    await writeFile(`${output}.json`, JSON.stringify({ ...header, tag: cipher.getAuthTag().toString("base64") }), { flag: "wx", mode: 0o600 });
  } catch {
    if (created) await rm(output, { force: true });
    throw new Error("Private release archive could not be sealed; no plaintext artifact may be uploaded.");
  } finally {
    await inputHandle?.close().catch(() => {});
    await outputHandle?.close().catch(() => {});
  }
}
export async function openReleaseArchive(source, output, identity, env = process.env) {
  let inputHandle, outputHandle, created = false;
  try {
    const metadata = JSON.parse((await readRegularFile(`${source}.json`, { minBytes: 1, maxBytes: 4096 })).toString("utf8"));
    const bound = context(identity), { keys } = keyring(env);
    if (Object.keys(metadata).sort().join() !== ["schemaVersion", "format", "keyVersion", "repository", "sourceCommit", "runId", "filename", "nonce", "tag"].sort().join() ||
        metadata.schemaVersion !== 1 || metadata.format !== "aes-256-gcm-stream-v1" || !keys.has(metadata.keyVersion)) throw new Error();
    for (const [name, expected] of Object.entries(bound)) if (metadata[name] !== expected) throw new Error();
    const decode = (value, size) => {
      if (typeof value !== "string") throw new Error();
      const bytes = Buffer.from(value, "base64");
      if (bytes.length !== size || bytes.toString("base64") !== value) throw new Error();
      return bytes;
    };
    const { tag, ...header } = metadata;
    const decipher = createDecipheriv("aes-256-gcm", keys.get(metadata.keyVersion), decode(metadata.nonce, 12));
    decipher.setAAD(Buffer.from(JSON.stringify(header)));
    decipher.setAuthTag(decode(tag, 16));
    inputHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await inputHandle.stat()).isFile()) throw new Error();
    outputHandle = await open(output, "wx", 0o600); created = true;
    await pipeline(inputHandle.createReadStream(), decipher, outputHandle.createWriteStream());
  } catch {
    if (created) await rm(output, { force: true });
    throw new Error("Private release archive authentication failed; no plaintext output was retained.");
  } finally {
    await inputHandle?.close().catch(() => {});
    await outputHandle?.close().catch(() => {});
  }
}
