import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { formatWithOptions, inspect, types } from "node:util";
import { serialize } from "node:v8";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { sealReleaseEvidence, openReleaseEvidence } from "./release-evidence.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const recordTypes = new Set(["session-start", "message-start", "message-chunk", "message-end", "session-end"]);
const inspectOptions = { colors: false, depth: null, maxArrayLength: null, maxStringLength: null, customInspect: false, getters: false };
const chunkBytes = 128 * 1024;
export function diagnosticIdentity(value) {
  if (value.repository !== "bentbrain/bent-mono" || !/^[a-f0-9]{40}$/.test(value.sourceCommit ?? "") ||
      !/^[1-9][0-9]*$/.test(String(value.runId)) || !/^[1-9][0-9]*$/.test(String(value.runAttempt)) ||
      !/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/.test(value.jobId ?? "")) throw new Error("Exact protected diagnostic identity is required.");
  return { repository: value.repository, sourceCommit: value.sourceCommit, runId: String(value.runId), runAttempt: String(value.runAttempt), jobId: value.jobId };
}
function validatedHeader(value, identity) {
  const bound = diagnosticIdentity(identity);
  for (const [name, expected] of Object.entries(bound)) if (value[name] !== expected) throw new Error("Diagnostic identity differs.");
  if (value.schemaVersion !== 1 || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.sessionId ?? "") ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 1 || !/^[a-f0-9]{64}$/.test(value.previousSha256 ?? "") ||
      !recordTypes.has(value.recordType) || !Number.isSafeInteger(value.messageSequence) || value.messageSequence < 0) throw new Error("Invalid diagnostic record header.");
  return { schemaVersion: 1, ...bound, sessionId: value.sessionId, sequence: value.sequence, previousSha256: value.previousSha256, recordType: value.recordType, messageSequence: value.messageSequence };
}
function evidenceIdentity(header) {
  return { sourceCommit: header.sourceCommit, runId: header.runId, filename: `diagnostic-${header.sequence}-${hash(JSON.stringify(header))}.json` };
}
function sealDiagnosticRecord(payload, metadata, env = process.env) {
  const header = validatedHeader(metadata, metadata);
  const encrypted = JSON.parse(sealReleaseEvidence({ header, payload }, evidenceIdentity(header), env));
  return { ...header, keyVersion: encrypted.keyVersion, nonce: encrypted.nonce, ciphertext: encrypted.ciphertext, tag: encrypted.tag };
}
export function openDiagnosticRecord(record, identity, env = process.env) {
  try {
    const header = validatedHeader(record, identity);
    const expectedKeys = [...Object.keys(header), "keyVersion", "nonce", "ciphertext", "tag"].sort();
    if (!isDeepStrictEqual(Object.keys(record).sort(), expectedKeys)) throw new Error();
    const encrypted = { schemaVersion: 1, keyVersion: record.keyVersion, repository: header.repository, ...evidenceIdentity(header), nonce: record.nonce, ciphertext: record.ciphertext, tag: record.tag };
    const value = openReleaseEvidence(JSON.stringify(encrypted), evidenceIdentity(header), env);
    if (!isDeepStrictEqual(value.header, header)) throw new Error();
    return { header, payload: value.payload };
  } catch { throw new Error("Protected diagnostic authentication failed."); }
}

// V8 serializes ordinary enumerable getters by calling them. Console inspection
// does not, so keep safe inspection for those values instead of changing them.
function safeToSerialize(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object") return typeof value !== "function" && typeof value !== "symbol";
  if (types.isProxy(value)) return false;
  if (seen.has(value)) return true;
  seen.add(value);
  if (types.isMap(value)) return [...Map.prototype.entries.call(value)].every(([key, item]) => safeToSerialize(key, seen) && safeToSerialize(item, seen));
  if (types.isSet(value)) return [...Set.prototype.values.call(value)].every(item => safeToSerialize(item, seen));
  if (types.isAnyArrayBuffer(value) || types.isArrayBufferView(value) || types.isDate(value) || types.isRegExp(value)) return true;
  if (types.isNativeError(value)) {
    for (const name of ["name", "message", "stack", "cause"]) {
      let current = value, descriptor;
      while (current) {
        if (types.isProxy(current)) return false;
        descriptor = Object.getOwnPropertyDescriptor(current, name);
        if (descriptor) break;
        current = Object.getPrototypeOf(current);
      }
      if (!descriptor) continue;
      if (descriptor.get || descriptor.set) {
        if (name !== "stack" || !descriptor.get || !Function.prototype.toString.call(descriptor.get).includes("[native code]")) return false;
      } else if (!safeToSerialize(descriptor.value, seen)) return false;
    }
    return true;
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.enumerable && (descriptor.get || descriptor.set || !safeToSerialize(descriptor.value, seen))) return false;
  }
  return true;
}

function formattedArguments(args) {
  let text, formattingError;
  try { text = formatWithOptions(inspectOptions, ...args); }
  catch (error) { formattingError = inspect(error, inspectOptions); text = inspect(args, inspectOptions); }
  const argumentsText = inspect(args, inspectOptions);
  let serializedArguments;
  try { if (safeToSerialize(args)) serializedArguments = serialize(args).toString("base64"); }
  catch { /* Functions/symbols retain their complete safe inspection instead. */ }
  return { text, argumentsText, ...(serializedArguments ? { serializedArguments, serialization: "node-v8" } : {}), ...(formattingError ? { formattingError } : {}) };
}
export function createDiagnosticWriter(directory, identity, env = process.env) {
  const bound = diagnosticIdentity(identity), sessionId = randomUUID();
  // Freeze only the protected key route, never the whole process environment.
  const keys = Object.fromEntries(["SHOP_EVIDENCE_KEY_VERSION", "SHOP_EVIDENCE_ENCRYPTION_KEY", "SHOP_EVIDENCE_PREVIOUS_KEYS_JSON"].map(name => [name, env[name]]));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error("Private diagnostic directory is invalid.");
  const path = join(directory, `session-${sessionId}.ndjson`);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let sequence = 0, previousSha256 = "0".repeat(64), messageSequence = 0, closed = false, failed = false;
  const append = (recordType, payload, message = messageSequence) => {
    const record = sealDiagnosticRecord(payload, { schemaVersion: 1, ...bound, sessionId, sequence: sequence + 1, previousSha256, recordType, messageSequence: message }, keys);
    const line = JSON.stringify(record), bytes = Buffer.from(`${line}\n`);
    for (let offset = 0; offset < bytes.length;) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written === 0) throw new Error("Protected diagnostic append stopped.");
      offset += written;
    }
    fsyncSync(fd);
    sequence += 1; previousSha256 = hash(line);
  };
  try { append("session-start", { createdAt: new Date().toISOString() }, 0); }
  catch (error) { closeSync(fd); throw error; }
  return {
    path,
    write(level, args) {
      try {
        if (closed || failed || typeof level !== "string" || !/^[a-z][a-z-]*$/.test(level)) throw new Error("Protected diagnostic writer is unavailable.");
        const value = { level, createdAt: new Date().toISOString(), ...formattedArguments(args) };
        const bytes = Buffer.from(JSON.stringify(value)), sha256 = hash(bytes), totalChunks = Math.ceil(bytes.length / chunkBytes);
        messageSequence += 1;
        append("message-start", { byteLength: bytes.length, sha256, totalChunks });
        for (let index = 0; index < totalChunks; index++) append("message-chunk", { index, bytes: bytes.subarray(index * chunkBytes, (index + 1) * chunkBytes).toString("base64") });
        append("message-end", { byteLength: bytes.length, sha256, totalChunks });
        return { sequence, messageSequence };
      } catch (error) { failed = true; throw error; }
    },
    finish() {
      if (closed) return;
      try { if (!failed) append("session-end", { messages: messageSequence }); }
      finally { closed = true; closeSync(fd); }
    },
  };
}

export function githubDiagnosticWriter(env = process.env) {
  if (env.GITHUB_ACTIONS !== "true" || !env.RUNNER_TEMP?.startsWith("/")) throw new Error("Protected GitHub diagnostic context is required.");
  const identity = diagnosticIdentity({ repository: env.GITHUB_REPOSITORY, sourceCommit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, jobId: env.GITHUB_JOB });
  return createDiagnosticWriter(join(env.RUNNER_TEMP, "shop-encrypted-diagnostics", identity.jobId, identity.runAttempt), identity, env);
}
