import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deserialize } from "node:v8";
import { createDiagnosticWriter } from "./release-diagnostics.mjs";
import { recoverReleaseDiagnostics } from "./recover-release-diagnostics.mjs";

const identity = { repository: "bentbrain/bent-mono", sourceCommit: "a".repeat(40), runId: "123", runAttempt: "2", jobId: "release_job" };
const key = { SHOP_EVIDENCE_KEY_VERSION: "v1", SHOP_EVIDENCE_ENCRYPTION_KEY: "07".repeat(32) };
const context = directory => ({ ...process.env, ...key, GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: identity.repository, GITHUB_SHA: identity.sourceCommit, GITHUB_RUN_ID: identity.runId, GITHUB_RUN_ATTEMPT: identity.runAttempt, GITHUB_JOB: identity.jobId, RUNNER_TEMP: directory });
const messages = async path => (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
async function fixture(action) {
  const directory = await mkdtemp(join(tmpdir(), "shop-log-test-"));
  try { await action(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("diagnostics preserve Error stacks, format arguments, circular and binary values, and messages over 4MiB", () => fixture(async directory => {
  const writer = createDiagnosticWriter(join(directory, "encrypted"), identity, key);
  const circular = { label: "private-circular" }; circular.self = circular;
  const error = new Error("private-error\nsecond-line");
  const bytes = Buffer.from([0, 255, 128, 10]);
  const large = `private-large\n${"x".repeat(4 * 1024 * 1024 + 7)}`;
  writer.write("error", ["private %s", "value", error, circular, bytes]);
  writer.write("debug", [large]); writer.finish();
  const ciphertext = await readFile(writer.path, "utf8");
  for (const value of ["private-error", "private-circular", "private-large", "second-line"]) assert.ok(!ciphertext.includes(value));
  assert.equal((await stat(writer.path)).mode & 0o777, 0o600);
  const records = ciphertext.trim().split("\n").map(JSON.parse);
  assert.ok(records.length > 40);
  records.forEach((record, index) => assert.equal(record.sequence, index + 1));
  const output = join(directory, "private.jsonl");
  assert.equal((await recoverReleaseDiagnostics(join(directory, "encrypted"), output, identity, { env: key })).complete, true);
  const decoded = await messages(output);
  assert.equal(decoded[0].level, "error");
  assert.ok(decoded[0].text.includes(error.stack));
  assert.ok(decoded[0].text.startsWith("private value"));
  const args = deserialize(Buffer.from(decoded[0].serializedArguments, "base64"));
  assert.equal(args[2].stack, error.stack); assert.equal(args[3].self, args[3]); assert.deepEqual(args[4], bytes);
  assert.equal(decoded[1].text, large);
  assert.equal(deserialize(Buffer.from(decoded[1].serializedArguments, "base64"))[0], large);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
}));

test("wrong identity/key and modified, missing, duplicated or reordered records publish no partial plaintext", () => fixture(async directory => {
  const writer = createDiagnosticWriter(directory, identity, key); writer.write("info", ["private-first"]); writer.write("warn", ["private-second"]); writer.finish();
  const lines = (await readFile(writer.path, "utf8")).trim().split("\n");
  const mutations = [
    value => { const record = JSON.parse(value[2]); record.ciphertext = `${record.ciphertext[0] === "A" ? "B" : "A"}${record.ciphertext.slice(1)}`; value[2] = JSON.stringify(record); },
    value => { const record = JSON.parse(value[2]); record.sequence++; value[2] = JSON.stringify(record); },
    value => { value.splice(2, 1); },
    value => { value.splice(2, 0, value[2]); },
    value => { [value[2], value[3]] = [value[3], value[2]]; },
    value => { const record = JSON.parse(value[2]); record.runAttempt = "3"; value[2] = JSON.stringify(record); },
    value => { const record = JSON.parse(value[2]); record.keyVersion = "v2"; value[2] = JSON.stringify(record); },
  ];
  for (let index = 0; index < mutations.length; index++) {
    const changed = [...lines]; mutations[index](changed); await writeFile(writer.path, `${changed.join("\n")}\n`);
    const output = join(directory, `rejected-${index}.jsonl`);
    await assert.rejects(recoverReleaseDiagnostics(writer.path, output, identity, { env: key, recoverInterrupted: true }));
    await assert.rejects(stat(output), { code: "ENOENT" });
  }
  await writeFile(writer.path, `${lines.join("\n")}\n`);
  for (const delta of [{ sourceCommit: "b".repeat(40) }, { runId: "124" }, { runAttempt: "3" }, { jobId: "other" }, { repository: "bentbrain/other" }]) {
    const output = join(directory, "bad-identity.jsonl");
    await assert.rejects(recoverReleaseDiagnostics(writer.path, output, { ...identity, ...delta }, { env: key }));
    await assert.rejects(stat(output), { code: "ENOENT" });
  }
  await assert.rejects(recoverReleaseDiagnostics(writer.path, join(directory, "bad-key.jsonl"), identity, { env: { ...key, SHOP_EVIDENCE_ENCRYPTION_KEY: "08".repeat(32) } }));
  const existing = join(directory, "existing.jsonl"); await writeFile(existing, "preserved");
  await assert.rejects(recoverReleaseDiagnostics(writer.path, existing, identity, { env: key }));
  assert.equal(await readFile(existing, "utf8"), "preserved");
  assert.ok(!(await readdir(directory)).some(name => name.startsWith(".shop-diagnostics-")));
}));

test("key rotation retains protected prior version and rejects removal or ambiguity", () => fixture(async directory => {
  const writer = createDiagnosticWriter(directory, identity, key); writer.write("log", ["retained"]); writer.finish();
  const rotated = { SHOP_EVIDENCE_KEY_VERSION: "v2", SHOP_EVIDENCE_ENCRYPTION_KEY: "08".repeat(32), SHOP_EVIDENCE_PREVIOUS_KEYS_JSON: JSON.stringify({ v1: key.SHOP_EVIDENCE_ENCRYPTION_KEY }) };
  await recoverReleaseDiagnostics(writer.path, join(directory, "rotated.jsonl"), identity, { env: rotated });
  await assert.rejects(recoverReleaseDiagnostics(writer.path, join(directory, "removed.jsonl"), identity, { env: { ...rotated, SHOP_EVIDENCE_PREVIOUS_KEYS_JSON: "" } }));
  await assert.rejects(recoverReleaseDiagnostics(writer.path, join(directory, "ambiguous.jsonl"), identity, { env: { ...key, SHOP_EVIDENCE_PREVIOUS_KEYS_JSON: rotated.SHOP_EVIDENCE_PREVIOUS_KEYS_JSON } }));
}));

test("abrupt process kill retains fsynced records and requires explicit incomplete-prefix recovery", () => fixture(async directory => {
  const child = spawn(process.execPath, ["--import", "./scripts/public-release-logging.mjs", "--input-type=module", "-e", 'console.info("private-before-kill"); setInterval(()=>{},1000);'], { env: context(directory), stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("error", reject); child.once("exit", () => reject(new Error("Child exited before capture"))); });
  const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGKILL"); await exited;
  const input = join(directory, "shop-encrypted-diagnostics", identity.jobId, identity.runAttempt);
  await assert.rejects(recoverReleaseDiagnostics(input, join(directory, "strict.jsonl"), identity, { env: key }));
  const output = join(directory, "prefix.jsonl");
  const result = await recoverReleaseDiagnostics(input, output, identity, { env: key, recoverInterrupted: true });
  assert.equal(result.complete, false); assert.equal((await messages(output))[0].text, "private-before-kill");
}));

test("truncated final append recovers only authenticated chunks and rejects terminated corruption", () => fixture(async directory => {
  const writer = createDiagnosticWriter(directory, identity, key); writer.write("info", ["private-first"]); writer.write("error", ["y".repeat(200000)]); writer.finish();
  const lines = (await readFile(writer.path, "utf8")).trim().split("\n");
  const second = lines.findIndex(line => { const value = JSON.parse(line); return value.recordType === "message-chunk" && value.messageSequence === 2; });
  await writeFile(writer.path, `${lines.slice(0, second + 1).join("\n")}\n${lines[second + 1].slice(0, 90)}`);
  const output = join(directory, "prefix.jsonl");
  const result = await recoverReleaseDiagnostics(writer.path, output, identity, { env: key, recoverInterrupted: true });
  assert.equal(result.complete, false); assert.equal(result.sessions[0].ignoredTailBytes, 90);
  const decoded = await messages(output); assert.equal(decoded[0].text, "private-first");
  assert.equal(decoded[1].recordType, "incomplete-message"); assert.equal(Buffer.from(decoded[1].authenticatedPrefixBase64, "base64").length, 128 * 1024);
  await writeFile(writer.path, `${lines.slice(0, second + 1).join("\n")}\n${lines[second + 1].slice(0, 90)}\n`);
  await assert.rejects(recoverReleaseDiagnostics(writer.path, join(directory, "tampered.jsonl"), identity, { env: key, recoverInterrupted: true }));
}));

test("preload encrypts full original diagnostics and uncaught stacks, without touching workflow outputs", () => fixture(async directory => {
  const env = { ...context(directory), GITHUB_OUTPUT: join(directory, "github-output") };
  const result = spawnSync(process.execPath, ["--import", "./scripts/public-release-logging.mjs", "--input-type=module", "-e", 'import{appendFileSync}from"node:fs";appendFileSync(process.env.GITHUB_OUTPUT,"value=preserved\\n");console.log("private-log\\nvalue");throw new Error("private-uncaught");'], { env, encoding: "utf8" });
  assert.equal(result.status, 1); assert.equal(result.stderr, "");
  assert.ok(!result.stdout.includes("private-log") && !result.stdout.includes("private-uncaught"));
  assert.equal(await readFile(env.GITHUB_OUTPUT, "utf8"), "value=preserved\n");
  const output = join(directory, "decoded.jsonl");
  await recoverReleaseDiagnostics(join(directory, "shop-encrypted-diagnostics", identity.jobId, identity.runAttempt), output, identity, { env: key });
  const decoded = await messages(output); assert.equal(decoded[0].text, "private-log\nvalue"); assert.match(decoded[1].text, /Error: private-uncaught[\s\S]*at /);
  const invalid = spawnSync(process.execPath, ["--import", "./scripts/public-release-logging.mjs", "-e", 'process.stdout.write("SHOULD-NOT-RUN")'], { env: { ...env, SHOP_EVIDENCE_ENCRYPTION_KEY: "bad" }, encoding: "utf8" });
  assert.equal(invalid.status, 1); assert.ok(!invalid.stdout.includes("SHOULD-NOT-RUN"));
}));

test("protected child preserves binary streams, large output and exact failure exit without public plaintext", () => fixture(async directory => {
  const env = { ...context(directory), GITHUB_OUTPUT: join(directory, "github-output") };
  const payload = Buffer.concat([Buffer.from([0, 255, 128]), Buffer.from(`private-child${"z".repeat(4 * 1024 * 1024 + 3)}`)]);
  const input = join(directory, "input"); await writeFile(input, payload);
  const result = spawnSync(process.execPath, ["scripts/protected-command.mjs", "--", process.execPath, "--input-type=module", "-e", 'import{readFileSync,appendFileSync}from"node:fs";appendFileSync(process.env.GITHUB_OUTPUT,"child=preserved\\n");process.stdout.write(readFileSync(process.env.PRIVATE_TEST_INPUT));process.stderr.write("private-stderr\\n");process.exitCode=7;'], { env: { ...env, PRIVATE_TEST_INPUT: input }, encoding: "utf8" });
  assert.equal(result.status, 7); assert.equal(result.stderr, ""); assert.ok(!result.stdout.includes("private-child") && !result.stdout.includes("private-stderr"));
  assert.equal(await readFile(env.GITHUB_OUTPUT, "utf8"), "child=preserved\n");
  const output = join(directory, "decoded.jsonl"); await recoverReleaseDiagnostics(join(directory, "shop-encrypted-diagnostics", identity.jobId, identity.runAttempt), output, identity, { env: key });
  const decoded = await messages(output);
  const stream = level => Buffer.concat(decoded.filter(value => value.level === level).map(value => deserialize(Buffer.from(value.serializedArguments, "base64"))[0]));
  assert.deepEqual(stream("child-stdout"), payload); assert.equal(stream("child-stderr").toString(), "private-stderr\n");
}));

test("private decoder CLI refuses automatic plaintext decoding in GitHub Actions", () => fixture(async directory => {
  const result = spawnSync(process.execPath, ["scripts/open-release-diagnostics.mjs", "--input", directory, "--output", join(directory, "private.jsonl")], { env: context(directory), encoding: "utf8" });
  assert.equal(result.status, 1); assert.equal(result.stdout, ""); await assert.rejects(stat(join(directory, "private.jsonl")), { code: "ENOENT" });
}));


test("protected GitHub summaries retain private details only in authenticated diagnostics", () => fixture(async directory => {
  const env = { ...context(directory), GITHUB_STEP_SUMMARY: join(directory, "summary") };
  const result = spawnSync(process.execPath, ["--import", "./scripts/public-release-logging.mjs", "--input-type=module", "-e", 'import{summary}from"./scripts/github-actions.mjs";summary("private immutable https://private.example/version");'], { env, encoding: "utf8" });
  assert.equal(result.status, 0); assert.equal(result.stderr, ""); assert.ok(!result.stdout.includes("private.example"));
  assert.ok(!(await readFile(env.GITHUB_STEP_SUMMARY, "utf8")).includes("private.example"));
  const output = join(directory, "decoded.jsonl");
  await recoverReleaseDiagnostics(join(directory, "shop-encrypted-diagnostics", identity.jobId, identity.runAttempt), output, identity, { env: key });
  assert.equal((await messages(output))[0].text, "private immutable https://private.example/version");
}));

test("every active captured job uploads only its ciphertext diagnostic directory on every outcome", async () => {
  const { releaseWorkflowNames } = await import("./activate-workflows.mjs");
  let jobs = 0;
  for (const name of [...releaseWorkflowNames, "native-qualification-schedule.yml"]) {
    const source = await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
    for (const job of source.split(/(?=^  [A-Za-z_][A-Za-z0-9_-]*:\n)/m)) {
      if (!/scripts\/(public-release-logging|protected-command)\.mjs/.test(job)) continue;
      jobs++;
      assert.match(job, /SHOP_EVIDENCE_ENCRYPTION_KEY: \$\{\{ secrets.SHOP_EVIDENCE_ENCRYPTION_KEY \}\}/, name);
      assert.match(job, /name: Preserve encrypted operational diagnostics\n        if: always\(\)\n        uses: actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/, name);
      assert.match(job, /name: shop-private-diagnostics-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}-\$\{\{ github.job \}\}/, name);
      assert.match(job, /path: \$\{\{ runner.temp \}\}\/shop-encrypted-diagnostics\/\$\{\{ github.job \}\}\/\$\{\{ github.run_attempt \}\}/, name);
    }
  }
  assert.equal(jobs, 13);
});


test("logging accessor and proxy values does not invoke getters or serialization traps", () => fixture(async directory => {
  let getterCalls = 0, proxyCalls = 0;
  const value = { label: "private-accessor", get secret() { getterCalls++; throw new Error("getter must not execute"); } };
  const proxy = new Proxy({ label: "private-proxy" }, { ownKeys() { proxyCalls++; throw new Error("proxy must not execute"); } });
  const writer = createDiagnosticWriter(directory, identity, key);
  writer.write("info", [value, proxy]); writer.finish();
  assert.equal(getterCalls, 0); assert.equal(proxyCalls, 0);
  const output = join(directory, "decoded.jsonl"); await recoverReleaseDiagnostics(writer.path, output, identity, { env: key });
  const decoded = (await messages(output))[0];
  assert.match(decoded.text, /private-accessor/); assert.match(decoded.argumentsText, /\[Getter\]/); assert.match(decoded.argumentsText, /private-proxy/);
  assert.equal(decoded.serializedArguments, undefined);
}));
