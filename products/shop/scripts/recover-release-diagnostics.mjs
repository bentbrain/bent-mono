import { constants } from "node:fs";
import { access, link, lstat, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { diagnosticIdentity, openDiagnosticRecord } from "./release-diagnostics.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
async function* records(handle) {
  let remaining = "";
  for await (const chunk of handle.createReadStream({ autoClose: false })) {
    if (chunk.some(value => value > 127)) throw new Error();
    remaining += chunk.toString("ascii");
    let end;
    while ((end = remaining.indexOf("\n")) !== -1) {
      const line = remaining.slice(0, end); remaining = remaining.slice(end + 1);
      if (!line.length || line.length > 6 * 1024 * 1024) throw new Error();
      yield { line, terminated: true };
    }
    if (remaining.length > 6 * 1024 * 1024) throw new Error();
  }
  if (remaining) yield { line: remaining, terminated: false };
}
function decodedChunk(value, expectedBytes) {
  if (typeof value !== "string") throw new Error();
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || bytes.length !== expectedBytes) throw new Error();
  return bytes;
}
async function recoverSession(path, output, identity, env, recoverInterrupted) {
  const match = /^session-([a-f0-9-]{36})\.ndjson$/.exec(basename(path));
  if (!match) throw new Error();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const before = await handle.stat();
  if (!before.isFile()) { await handle.close(); throw new Error(); }
  const sessionId = match[1];
  let sequence = 1, previousSha256 = "0".repeat(64), keyVersion, messageSequence = 0, messages = 0, pending, ended = false, incomplete = false, ignoredTailBytes = 0;
  try {
    for await (const { line, terminated } of records(handle)) {
      if (ended) throw new Error();
      let record;
      if (!terminated) {
        if (!recoverInterrupted) throw new Error();
        incomplete = true;
        try { record = JSON.parse(line); }
        catch { if (sequence === 1) throw new Error(); ignoredTailBytes = Buffer.byteLength(line); break; }
      } else record = JSON.parse(line);
      const { header, payload } = openDiagnosticRecord(record, identity, env);
      if (header.sessionId !== sessionId || header.sequence !== sequence || header.previousSha256 !== previousSha256 || keyVersion && record.keyVersion !== keyVersion) throw new Error();
      keyVersion = record.keyVersion;
      previousSha256 = sha(line); sequence++;
      if (header.recordType === "session-start") {
        if (header.sequence !== 1 || header.messageSequence !== 0 || !payload || typeof payload.createdAt !== "string") throw new Error();
      } else if (header.sequence === 1) throw new Error();
      else if (header.recordType === "message-start") {
        if (pending || header.messageSequence !== messageSequence + 1 || !Number.isSafeInteger(payload?.byteLength) || payload.byteLength < 1 ||
            !/^[a-f0-9]{64}$/.test(payload.sha256 ?? "") || payload.totalChunks !== Math.ceil(payload.byteLength / (128 * 1024))) throw new Error();
        messageSequence = header.messageSequence;
        pending = { metadata: payload, parts: [], digest: createHash("sha256"), bytes: 0, nextIndex: 0 };
      } else if (header.recordType === "message-chunk") {
        if (!pending || header.messageSequence !== messageSequence || payload?.index !== pending.nextIndex || pending.nextIndex >= pending.metadata.totalChunks) throw new Error();
        const bytes = decodedChunk(payload.bytes, Math.min(128 * 1024, pending.metadata.byteLength - pending.bytes));
        pending.parts.push(bytes); pending.digest.update(bytes); pending.bytes += bytes.length; pending.nextIndex++;
      } else if (header.recordType === "message-end") {
        if (!pending || header.messageSequence !== messageSequence || !isDeepStrictEqual(payload, pending.metadata) || pending.nextIndex !== payload.totalChunks ||
            pending.bytes !== payload.byteLength || pending.digest.digest("hex") !== payload.sha256) throw new Error();
        const value = JSON.parse(Buffer.concat(pending.parts).toString("utf8"));
        if (typeof value.level !== "string" || typeof value.text !== "string" || typeof value.argumentsText !== "string") throw new Error();
        await output.writeFile(`${JSON.stringify({ recordType: "message", ...identity, sessionId, messageSequence, ...value })}\n`);
        pending = undefined; messages++;
      } else if (header.recordType === "session-end") {
        if (pending || header.messageSequence !== messageSequence || payload?.messages !== messages) throw new Error();
        ended = true;
      } else throw new Error();
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || sequence === 1) throw new Error();
    const complete = ended && !pending && !incomplete;
    if (!complete && !recoverInterrupted) throw new Error();
    if (pending) await output.writeFile(`${JSON.stringify({ recordType: "incomplete-message", ...identity, sessionId, messageSequence, expectedByteLength: pending.metadata.byteLength, authenticatedPrefixBase64: Buffer.concat(pending.parts).toString("base64"), incomplete: true })}\n`);
    const state = { recordType: "session-state", ...identity, sessionId, keyVersion, authenticatedRecords: sequence - 1, completedMessages: messages, complete, ignoredTailBytes };
    await output.writeFile(`${JSON.stringify(state)}\n`);
    return state;
  } finally { await handle.close(); }
}

export async function recoverReleaseDiagnostics(input, outputPath, identity, { env = process.env, recoverInterrupted = false } = {}) {
  const bound = diagnosticIdentity(identity);
  let temporary, output;
  try {
    try { await access(outputPath); throw new Error(); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const info = await lstat(input);
    if (info.isSymbolicLink()) throw new Error();
    const paths = info.isDirectory() ? (await readdir(input)).sort().map(name => join(input, name)) : [input];
    if (!paths.length) throw new Error();
    temporary = await mkdtemp(join(dirname(outputPath), ".shop-diagnostics-"));
    const staged = join(temporary, "authenticated-diagnostics.jsonl");
    output = await open(staged, "wx", 0o600);
    const sessions = [];
    for (const path of paths) sessions.push(await recoverSession(path, output, bound, env, recoverInterrupted));
    await output.sync(); await output.close(); output = undefined;
    await link(staged, outputPath);
    return { complete: sessions.every(session => session.complete), sessions };
  } catch { throw new Error("Protected diagnostic verification failed; no plaintext output was published."); }
  finally {
    await output?.close().catch(() => {});
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
