import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const workflow = () => read(".github/workflows/shop-native-validation.yml");
const step = (source, name) => source.split(`      - name: ${name}\n`)[1]?.split("      - ")[0];
const script = block => block.split("        run: |\n")[1].split("\n").map(line => line.replace(/^ {10}/, "")).join("\n");

test("Shop validation runs the complete native composite in its pinned job environment", () => {
  const source = workflow();
  const native = read(".github/workflows/native-development.yml").split("  check:\n")[1].split("\n  build:")[0];
  const environment = value => value.split("    runs-on: ")[1].split("    timeout-minutes:")[0];
  assert.equal(environment(source), environment(native));
  assert.match(source, /on:\n  pull_request:\n/);
  for (const path of ["products/shop/**", ".github/**", "scripts/**", "packages/design-tokens/**", "packages/ui/**", "bun.lock", "package.json", "turbo.json"])
    assert.ok(source.includes(`      - '${path}'`), path);
  assert.deepEqual([...source.matchAll(/^  ([\w-]+):$/gm)].map(match => match[1]), ["pull_request", "check"]);
  assert.match(source, /uses: \.\/products\/shop\/\.github\/actions\/check\n        with:\n          node-version: '24\.18\.0'\n          fresh: 'true'\n          suite: all/);
  const action = read("products/shop/.github/actions/check/action.yml");
  assert.match(action, /bun-version: 1\.4\.4/);
  assert.ok(action.indexOf("run: bun run test:e2e:ci") < action.indexOf("run: bun run check:ci"));
  assert.match(action, /CI_FRESH_VALIDATION: \$\{\{ inputs\.fresh \}\}/);
  assert.match(source, /Trust the mounted checkout\n        run: git config --global --add safe.directory "\$GITHUB_WORKSPACE"\n        working-directory: \./);
  assert.ok(source.indexOf("Trust the mounted checkout") < source.indexOf("uses: actions/checkout@"));
  assert.match(source, /persist-credentials: false/);
  for (const reference of source.matchAll(/uses: ([^\s]+)/g))
    assert.ok(reference[1].startsWith("./") || /@[a-f0-9]{40}$/.test(reference[1]), reference[1]);
});

test("Shop validation has only synthetic configuration and read-only artifact authority", () => {
  const source = workflow();
  assert.match(source, /permissions:\n  contents: read\n  actions: read\n/);
  assert.doesNotMatch(source, /\bwrite\b|\bsecrets\.|\benvironment:|id-token|pull_request_target|workflow_dispatch|release-(?:preflight|coordinator|dispatch)|native-release|configure-aws|aws-personal|wrangler|vercel|deploy\.yml/);
  assert.deepEqual([...source.matchAll(/^      - (?:name: ([^\n]+)|uses: ([^\s]+))/gm)].map(match => match[1] ?? match[2]), [
    "Trust the mounted checkout", "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803", "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    "Configure synthetic validation", "Run the complete native checks", "Download composite evidence", "Verify composite evidence",
  ]);
  const config = script(step(source, "Configure synthetic validation"));
  assert.match(config, /validationEnvironment\(\{\}\)/);
  assert.match(config, /delete env\.GITHUB_SHA/);
  const directory = mkdtempSync(join(tmpdir(), "shop-validation-env-"));
  try {
    const output = join(directory, "env");
    execFileSync("/bin/bash", ["-euo", "pipefail", "-c", config], {
      cwd: new URL("../products/shop/", import.meta.url), env: { PATH: process.env.PATH, GITHUB_ENV: output },
    });
    const entries = readFileSync(output, "utf8").trim().split("\n").map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]);
    const env = Object.fromEntries(entries);
    assert.equal(env.GITHUB_SHA, undefined);
    assert.deepEqual(JSON.parse(env.SHOP_PROTECTED_CONFIG_JSON), JSON.parse(read("products/shop/scripts/protected-config.fixtures.json")));
    assert.equal(env.SHOP_EVIDENCE_ENCRYPTION_KEY, "07".repeat(32));
    assert.equal(env.PUBLIC_STORE_DOMAIN, "ci.myshopify.com");
    assert.equal(env.FOREVER_TEE_API_URL, "https://api.example.com");
    assert.ok(!Object.keys(env).some(key => /^(?:AWS_|CLOUDFLARE_|GH_TOKEN|GITHUB_TOKEN|ACTIONS_ID_TOKEN)/.test(key)));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the hosted evidence verifier checks the downloaded composite bytes and full fresh execution", () => {
  const source = workflow();
  const download = step(source, "Download composite evidence");
  assert.match(download, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(download, /gh run download "\$GITHUB_RUN_ID" --repo "\$GITHUB_REPOSITORY"/);
  assert.match(download, /--name "task-cache-\$GITHUB_RUN_ID-\$GITHUB_JOB-"/);
  const verify = script(step(source, "Verify composite evidence"));
  const directory = mkdtempSync(join(tmpdir(), "shop-validation-evidence-"));
  try {
    const evidence = join(directory, "composite-evidence");
    mkdirSync(evidence);
    const task = name => ({ task: name, cache: "MISS", executed: true });
    const repositoryTasks = ['apps/web', 'workers/api', 'workers/video-renderer', 'packages/contracts', 'packages/product-image-renderer'].flatMap(directory => {
      const manifest = JSON.parse(read(`products/shop/${directory}/package.json`));
      return ['test', 'lint', 'typecheck', 'types:check', 'build'].filter(command => manifest.scripts[command]).map(command => task(`${manifest.name}#${command}`));
    });
    const report = { schemaVersion: 1, runs: [
      { exitCode: 0, tasks: [task("@forever-tee/web#test:e2e:local")] },
      { exitCode: 0, tasks: [...repositoryTasks, task('@forever-tee/web#verify:worker-release')] },
    ] };
    const original = join(directory, "task-cache-check.json");
    const downloaded = join(evidence, "task-cache-check.json");
    const run = () => execFileSync("/bin/bash", ["-euo", "pipefail", "-c", verify], {
      cwd: new URL("../products/shop/", import.meta.url), env: { PATH: process.env.PATH, RUNNER_TEMP: directory, GITHUB_JOB: "check" }, stdio: "pipe",
    });
    const put = value => { const bytes = JSON.stringify(value); writeFileSync(original, bytes); writeFileSync(downloaded, bytes); };
    put(report);
    run();
    writeFileSync(downloaded, "{}");
    assert.throws(run, /downloaded composite evidence/);
    for (const mutate of [
      value => { value.runs.pop(); },
      value => { value.runs[1].exitCode = 1; },
      value => { value.runs[0].tasks[0].executed = false; },
      value => { value.runs[1].tasks[0].cache = "HIT"; },
      value => { value.runs[1].tasks = value.runs[1].tasks.filter(task => task.task !== "@forever-tee/video-renderer#test"); },
    ]) {
      const changed = structuredClone(report); mutate(changed); put(changed); assert.throws(run);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
