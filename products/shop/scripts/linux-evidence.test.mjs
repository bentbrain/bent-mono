import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { access, copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openLinuxEvidence, sealLinuxEvidence } from "./testing/linux-evidence.mjs";
import { readRegularFile } from "./read-regular-file.mjs";

const keys = generateKeyPairSync("rsa", { modulusLength: 3072 });
const wrongKeys = generateKeyPairSync("rsa", { modulusLength: 3072 });
const recipient = { schema: "shop.linux-evidence-recipient/v1", algorithm: "RSA-OAEP-SHA256",
  publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }),
  spkiSha256: createHash("sha256").update(keys.publicKey.export({ type: "spki", format: "der" })).digest("hex") };
const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" });
const identity = { sourceCommit: "a".repeat(40), runId: "123", filename: "linux-evidence.json" };
const options = { privateKeyPem, keyFingerprint: recipient.spkiSha256 };

test("public-recipient evidence round-trips large bytes using fresh session keys and private files", async () => {
  const root = await mkdtemp(join(tmpdir(), "shop-linux-public-recipient-"));
  try {
    const original = Buffer.from("synthetic private diagnostic bytes\n".repeat(160000));
    const source = join(root, "source.bin"), output = join(root, "restored.bin");
    await writeFile(source, original, { mode: 0o600 });
    const archives = [join(root, "first.enc"), join(root, "second.enc")];
    for (const archive of archives) {
      await sealLinuxEvidence(source, archive, identity, archive === archives[0] ? recipient : { publicKeyPem: recipient.publicKeyPem, keyFingerprint: recipient.spkiSha256 });
      for (const path of [archive, `${archive}.json`, `${archive}.envelope.json`]) assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await readFile(archive)).includes(Buffer.from("synthetic private diagnostic")), false);
      assert.equal((await readFile(`${archive}.envelope.json`, "utf8")).includes("PRIVATE KEY"), false);
    }
    assert.notDeepEqual(await readFile(archives[0]), await readFile(archives[1]));
    const envelopes = await Promise.all(archives.map(async archive => JSON.parse(await readFile(`${archive}.envelope.json`, "utf8"))));
    assert.notEqual(envelopes[0].wrappedKey, envelopes[1].wrappedKey);
    await openLinuxEvidence(archives[0], output, identity, options);
    assert.deepEqual(await readRegularFile(output, { privateOnly: true, maxBytes: 16 * 1024 * 1024 }), original);
    await assert.rejects(openLinuxEvidence(archives[0], output, identity, options), /authentication failed/);
    assert.deepEqual(await readRegularFile(output, { privateOnly: true, maxBytes: 16 * 1024 * 1024 }), original, "Existing output must survive a refused overwrite");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("wrong recipient, identity, modified envelope, ciphertext and truncation leave no plaintext", async () => {
  const root = await mkdtemp(join(tmpdir(), "shop-linux-evidence-tamper-"));
  try {
    const source = join(root, "source"), archive = join(root, "original.enc");
    await writeFile(source, Buffer.from("sensitive synthetic bytes\n".repeat(10000)), { mode: 0o600 });
    await sealLinuxEvidence(source, archive, identity, recipient);
    const original = await readFile(archive), metadata = await readFile(`${archive}.json`), envelope = await readFile(`${archive}.envelope.json`);
    const cases = [
      { name: "wrong-key", options: { ...options, privateKeyPem: wrongKeys.privateKey.export({ type: "pkcs8", format: "pem" }) } },
      { name: "wrong-fingerprint", options: { ...options, keyFingerprint: "b".repeat(64) } },
      { name: "wrong-source", identity: { ...identity, sourceCommit: "b".repeat(40) } },
      { name: "wrong-run", identity: { ...identity, runId: "124" } },
      { name: "wrong-filename", identity: { ...identity, filename: "other-evidence.json" } },
      { name: "ciphertext", ciphertext: (() => { const bytes = Buffer.from(original); bytes[100] ^= 1; return bytes; })() },
      { name: "truncated-ciphertext", ciphertext: original.subarray(0, original.length - 1) },
      { name: "truncated-envelope", envelope: envelope.subarray(0, envelope.length - 5) },
      { name: "wrapped-key", mutate: value => { const bytes = Buffer.from(value.wrappedKey, "base64"); bytes[2] ^= 1; value.wrappedKey = bytes.toString("base64"); } },
      { name: "envelope-source", mutate: value => { value.identity.sourceCommit = "b".repeat(40); } },
      { name: "envelope-fingerprint", mutate: value => { value.keyFingerprint = "b".repeat(64); } },
      { name: "algorithm", mutate: value => { value.algorithm = "RSA-OAEP-SHA1"; } },
      { name: "extra-field", mutate: value => { value.unbound = true; } },
      { name: "aes-metadata", metadata: Buffer.from(metadata.toString().replace('"v1"', '"v2"')) },
    ];
    for (const scenario of cases) {
      const candidate = join(root, `${scenario.name}.enc`), output = join(root, `${scenario.name}.plain`);
      await writeFile(candidate, scenario.ciphertext ?? original, { mode: 0o600 });
      await writeFile(`${candidate}.json`, scenario.metadata ?? metadata, { mode: 0o600 });
      const value = JSON.parse(envelope.toString()); scenario.mutate?.(value);
      await writeFile(`${candidate}.envelope.json`, scenario.envelope ?? JSON.stringify(value), { mode: 0o600 });
      await assert.rejects(openLinuxEvidence(candidate, output, scenario.identity ?? identity, scenario.options ?? options), /authentication failed/, scenario.name);
      await assert.rejects(access(output), { code: "ENOENT" }, scenario.name);
    }
    const existing = join(root, "existing.enc"); await copyFile(archive, existing);
    await assert.rejects(sealLinuxEvidence(source, existing, identity, recipient), /could not be sealed/);
    assert.deepEqual(await readFile(existing), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("sealing rejects mismatched fingerprints, private PEM and unknown recipient fields before output", async () => {
  const root = await mkdtemp(join(tmpdir(), "shop-linux-recipient-config-"));
  try {
    const source = join(root, "source"); await writeFile(source, "synthetic", { mode: 0o600 });
    const recipients = [{ ...recipient, spkiSha256: "b".repeat(64) }, { ...recipient, publicKeyPem: privateKeyPem },
      { ...recipient, algorithm: "RSA-OAEP-SHA1" }, { ...recipient, extra: true }];
    for (let index = 0; index < recipients.length; index++) {
      const output = join(root, `${index}.enc`);
      await assert.rejects(sealLinuxEvidence(source, output, identity, recipients[index]), /could not be sealed/);
      await assert.rejects(access(output), { code: "ENOENT" });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
