import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertLinuxRuntime, fileInventory, packageLinuxCandidate, recipe, sharedLibraries, sourceInventory } from "./testing/linux-candidate.mjs";
import { verifyJourneyEvents } from "./testing/linux-journey.mjs";

test("Linux runtime admission rejects host, architecture, Node and ABI drift", async () => {
  const runtime = { platform: recipe.platform, arch: recipe.arch, node: recipe.node, nodeAbi: recipe.nodeAbi };
  assert.doesNotThrow(() => assertLinuxRuntime(runtime));
  for (const patch of [{ platform: "darwin" }, { arch: "arm64" }, { node: "v24.17.0" }, { nodeAbi: "136" }])
    assert.throws(() => assertLinuxRuntime({ ...runtime, ...patch }), /Linux candidate requires/);
  if (process.platform !== "linux" || process.arch !== "x64")
    await assert.rejects(packageLinuxCandidate("/unused-candidate-admission-test"), /Linux candidate requires/);
});

test("complete source inventory records additions, deletions, executable mode and symlink bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "linux-source-inventory-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    await writeFile(join(root, ".gitignore"), "ignored\n");
    await writeFile(join(root, "source"), "first\n");
    await writeFile(join(root, "ignored"), "private local state\n");
    execFileSync("git", ["add", ".gitignore", "source"], { cwd: root });
    const first = await sourceInventory(root);
    assert.deepEqual(first.files.map(file => file.path), [".gitignore", "source"]);
    await chmod(join(root, "source"), 0o700);
    await symlink("source", join(root, "link"));
    await writeFile(join(root, "new-source"), "addition\n");
    const second = await sourceInventory(root);
    assert.notEqual(first.sha256, second.sha256);
    assert.equal(second.files.find(file => file.path === "source").mode, "100755");
    assert.deepEqual(second.files.find(file => file.path === "link"), { path: "link", kind: "symlink", mode: "120000", bytes: 6,
      sha256: "41cf6794ba4200b839c53531555f0f3998df4cbb01a4d5cb0b94e3ca5e23947d" });
    await rm(join(root, "new-source"));
    assert.ok(!(await sourceInventory(root)).files.some(file => file.path === "new-source"));
    // A tracked input disappearing must fail closed, even before a source snapshot can be compared.
    await rm(join(root, "source"));
    await assert.rejects(sourceInventory(root), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("runtime inventory detects byte and executable changes and refuses symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "linux-runtime-inventory-"));
  try {
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin/ffmpeg"), "version one\n", { mode: 0o600 });
    const before = await fileInventory(root);
    await chmod(join(root, "bin/ffmpeg"), 0o700);
    assert.notDeepEqual(await fileInventory(root), before);
    await writeFile(join(root, "bin/ffmpeg"), "version two\n");
    assert.notEqual((await fileInventory(root))[0].sha256, before[0].sha256);
    await symlink("ffmpeg", join(root, "bin/alias"));
    await assert.rejects(fileInventory(root), /materialized/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ELF closure requires the x64 loader and all libraries to resolve", () => {
  const ldd = "\tlinux-vdso.so.1 (0x00007ffff)\n\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007aaaa)\n\t/lib64/ld-linux-x86-64.so.2 (0x00007bbbb)\n";
  assert.deepEqual(sharedLibraries(ldd), ["/lib/x86_64-linux-gnu/libc.so.6", "/lib64/ld-linux-x86-64.so.2"]);
  assert.throws(() => sharedLibraries(ldd + "\tlibbroken.so => not found\n"), /unavailable/);
  assert.throws(() => sharedLibraries(ldd.split("\n").filter(line => !line.includes("ld-linux")).join("\n")), /loader required/);
});

test("actual J01 observation admission rejects missing work, outbound traffic, camera calls and live checkout", () => {
  const names = ["built-start-create", "foreign-owner-draft-and-source-denied", "direct-editor-gesture", "editor-reload", "sse-first-bytes",
    "unready-print-checkout-denied", "prepared-source-verified", "stored-image-verified", "stored-print-verified", "sse-complete-and-reconnect",
    "inert-checkout-handoff", "manual-pause-checkout-denied", "wrong-image-callback-denied", "actual-business-scheduled", "product-controls", "journey", "native-v5", "native-video"];
  const value = { blocked: [], events: [
    ...names.map(operation => ({ operation })),
    ...Array.from({ length: 4 }, () => ({ operation: "stored-video-verified" })),
    { operation: "synthetic-source", width: 5000, height: 10000, format: "jpeg", exifOrientation: 6 },
  ] };
  value.events.find(event => event.operation === "product-controls").cameraCalls = 0;
  value.events.find(event => event.operation === "inert-checkout-handoff").location = "https://checkout.example.invalid/cart/c/J01";
  assert.doesNotThrow(() => verifyJourneyEvents(value));
  for (const mutate of [
    changed => { changed.events = changed.events.filter(event => event.operation !== "stored-print-verified"); },
    changed => { changed.blocked.push({ origin: "https://outside.invalid" }); },
    changed => { changed.events.find(event => event.operation === "product-controls").cameraCalls = 1; },
    changed => { changed.events.find(event => event.operation === "inert-checkout-handoff").location = "https://live-checkout.invalid"; },
    changed => { changed.events.find(event => event.operation === "synthetic-source").width = 1600; },
    changed => { changed.events.pop(); },
  ]) { const changed = structuredClone(value); mutate(changed); assert.throws(() => verifyJourneyEvents(changed)); }
});

test("hosted Linux validation pins the recipe, limits authority and uploads encrypted evidence only", async () => {
  const source = await readFile(new URL("../../../.github/workflows/shop-linux-journey.yml", import.meta.url), "utf8");
  assert.ok(source.includes(`image: ${recipe.baseImage}`));
  assert.match(source, /node-version: 24\.18\.0/);
  assert.match(source, /bun-version: 1\.4\.4/);
  assert.match(source, /permissions:\n  contents: read\n/);
  assert.doesNotMatch(source, /environment:|secrets\.|vars\./);
  assert.doesNotMatch(source, /id-token|pull_request_target|configure-aws|AWS_|CLOUDFLARE_|SHOP_PROTECTED_CONFIG_JSON|wrangler deploy|deploy:|secrets\.(?!SHOP_EVIDENCE_ENCRYPTION_KEY)/);
  assert.match(source, /head\.repo\.full_name == github\.repository/);
  assert.doesNotMatch(source, /SHOP_EVIDENCE_ENCRYPTION_KEY/);
  assert.match(source, /github\.repository == 'bentbrain\/bent-mono'/);
  for (const reference of source.matchAll(/uses: ([^\s]+)/g)) assert.match(reference[1], /@[a-f0-9]{40}$/);
  const artifacts = [...source.matchAll(/^          path: (.+)$/gm)].map(match => match[1]);
  assert.deepEqual(artifacts, ["${{ runner.temp }}/shop-linux-sealed"]);
});
