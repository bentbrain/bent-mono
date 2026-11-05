import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { githubApi } from "./github-actions.mjs";
import { reuseCi } from "./reuse-ci.mjs";
import { gitChanges } from "./deployment-plan.mjs";
import { PRODUCT_ROOT, REPOSITORY_ROOT } from "./monorepo-source.mjs";
import { validationEnvironment } from "./validation-environment.mjs";

const sha = "a".repeat(40);
const context = { sha, repository: "bentbrain/bent-mono", branch: "main", trustedMain: true };
const source = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPOSITORY_ROOT, encoding: "utf8" }).trim();

test("an absent historical CI workflow selects full validation; other API failures block", async () => {
  const api = status => githubApi({ token: "synthetic-token", repository: context.repository,
    fetcher: async url => {
      if (!url.includes("/actions/workflows/ci.yml/runs?")) {
        if (url.includes("/actions/workflows/") && url.includes("/runs?")) return Response.json({ workflow_runs: [] });
        if (url.includes("/commits/") && url.includes("/pulls?")) return Response.json([]);
        throw new Error("Unexpected API request");
      }
      return new Response("untrusted response content", { status });
    },
  });
  assert.equal(await reuseCi({ ...context, sha: source(), api: api(404) }), undefined);
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(reuseCi({ ...context, api: api(status) }), error =>
      error.status === status && !error.message.includes("untrusted response content") && !error.message.includes("synthetic-token"));
  }
});

test("the activated protected CLI emits reused=false for the first monorepo release", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shop-ci-adapter-"));
  try {
    const mock = join(directory, "fetch.mjs"), output = join(directory, "output"), summary = join(directory, "summary"), calls = join(directory, "calls");
    const commit = source();
    await writeFile(mock, `import { appendFileSync } from "node:fs";
    Object.defineProperty(process, "platform", { value: "linux" });
    Object.defineProperty(process, "arch", { value: "x64" });
    globalThis.fetch = async url => {
      appendFileSync(${JSON.stringify(calls)}, url + "\\n");
      if (url === ${JSON.stringify(`https://api.github.com/repos/${context.repository}/actions/workflows/ci.yml/runs?head_sha=${commit}&per_page=100`)}) return new Response("Absent historical workflow", { status: 404 });
      if (${JSON.stringify(["deploy", "web-production", "native-development"].map(name => `https://api.github.com/repos/${context.repository}/actions/workflows/${name}.yml/runs?branch=main&event=workflow_dispatch&per_page=20`))}.includes(url)) return Response.json({ workflow_runs: [] });
      if (url === ${JSON.stringify(`https://api.github.com/repos/${context.repository}/commits/${commit}/pulls?per_page=100`)}) return Response.json([]);
      throw new Error("Unexpected API request");
    };`);
    execFileSync(process.execPath, ["--import", mock, "--import", "./scripts/public-release-logging.mjs", "scripts/reuse-ci.mjs"], {
      cwd: PRODUCT_ROOT, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
      env: { ...validationEnvironment(), GH_TOKEN: "synthetic-token", NODE_OPTIONS: "", ImageOS: "ubuntu24", ImageVersion: "20261105.1",
        GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: context.repository, GITHUB_SHA: commit,
        GITHUB_REF_NAME: "main", GITHUB_REF: "refs/heads/main", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1",
        GITHUB_JOB: "check", RUNNER_TEMP: directory, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
    });
    assert.equal(await readFile(output, "utf8"), "reused=false\n");
    assert.match(await readFile(summary, "utf8"), /Protected release status recorded/);
    assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 5);
    for (const name of ["deploy.yml", "web-production.yml", "native-development.yml"]) {
      const workflow = await readFile(join(REPOSITORY_ROOT, ".github/workflows", name), "utf8");
      assert.ok(workflow.indexOf(name === "deploy.yml" ? "Require authoritative storefront release admission" : "Require authoritative exact-main monorepo quality") < workflow.indexOf("scripts/reuse-ci.mjs"));
      assert.match(workflow, /if: steps\.ci\.outputs\.reused != 'true'\n\s+uses: \.\/products\/shop\/\.github\/actions\/check/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the actual composite browser install command resolves Playwright without package exec", async () => {
  const action = await readFile(new URL("../.github/actions/check/action.yml", import.meta.url), "utf8");
  const block = action.split("    - name: Install local browser and OS dependencies\n")[1]?.split("    - name:")[0];
  const command = /^      run: (.+)$/m.exec(block)?.[1];
  const directory = /^      working-directory: (.+)$/m.exec(block)?.[1];
  assert.ok(command && directory, "the actual fallback install step must exist");
  assert.match(command, /^(?:bunx --no-install playwright|bun run --filter @forever-tee\/web exec playwright) install --with-deps chromium$/);
  const output = execFileSync("bash", ["-c", `${command} --dry-run`], {
    cwd: join(REPOSITORY_ROOT, directory), encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(directory, "products/shop/apps/web");
  assert.match(output, /chromium/i);
});

test("the release-preflight file URL classifies nonempty repository history like a path", () => {
  const git = (...args) => execFileSync("git", args, { cwd: REPOSITORY_ROOT, encoding: "utf8" }).trim();
  const source = git("rev-parse", "HEAD"), base = git("rev-parse", "HEAD^1");
  const paths = gitChanges(base, source, PRODUCT_ROOT);
  assert.ok(paths.length > 0);
  assert.deepEqual(gitChanges(base, source, pathToFileURL(PRODUCT_ROOT)), paths);
  assert.deepEqual(gitChanges(base, source, pathToFileURL(REPOSITORY_ROOT)), paths);
  assert.deepEqual(gitChanges(source, source, pathToFileURL(PRODUCT_ROOT)), []);
});

test("Worker secret steps preserve the complete synthetic JSON stream across their directory change", async () => {
  for (const [workflow, step, environment] of [["deploy.yml", "Configure Worker secrets", "development"], ["shopify-production-cutover.yml", "Configure Shopify Worker secrets", "production"]]) {
    const directory = await mkdtemp(join(tmpdir(), "shop-secret-stream-"));
    try {
      await mkdir(join(directory, "bin"));
      await mkdir(join(directory, "workers/api"), { recursive: true });
      const captured = join(directory, "captured.json");
      await writeFile(join(directory, "bin/bunx"), `#!/usr/bin/env node
        const fs = require("node:fs");
        if (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(["--no-install", "wrangler", "secret", "bulk", "--env", environment]))}) throw new Error("Unexpected command");
        const value = JSON.parse(fs.readFileSync(0, "utf8"));
        fs.writeFileSync(${JSON.stringify(captured)}, JSON.stringify(value), { flag: "wx", mode: 0o600 });
      `, { mode: 0o700 });
      const source = await readFile(join(PRODUCT_ROOT, ".github/workflows", workflow), "utf8");
      const block = source.split(`      - name: ${step}\n`)[1]?.split("      - name:")[0];
      const body = block.split("        run: |\n")[1].split("\n").map(line => line.replace(/^ {10}/, "")).join("\n");
      const script = body.includes("<<'SHOP_PROTECTED_SHELL'") ? body.split("<<'SHOP_PROTECTED_SHELL'\n")[1].split("\nSHOP_PROTECTED_SHELL")[0] : body;
      const names = ["BENT_SHIRT_OPERATIONS_SECRET", "CART_LINE_CAPABILITY_SECRET", "FOREVER_TEE_API_SHARED_SECRET", "OPENAI_API_KEY", "PRINTIFY_ASSET_DELIVERY_SECRET", "PRINTIFY_API_TOKEN", "PRINTIFY_SHOP_ID", "PRINTIFY_WEBHOOK_SECRET", "SCHEDULED_TASK_SECRET", "SHOPIFY_ADMIN_STORE_DOMAIN", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"];
      const fixtures = Object.fromEntries(names.map(name => [name, `synthetic-${name}`]));
      execFileSync("bash", ["-euo", "pipefail", "-c", script], { cwd: directory, timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...fixtures, PATH: join(directory, "bin") + ":" + process.env.PATH,
          DEPLOY_ENV: environment, WORKER_URL: "https://worker.example.invalid", WEB_ORIGIN: "https://web.example.invalid" } });
      const result = JSON.parse(await readFile(captured, "utf8"));
      assert.equal(result.SHOPIFY_CLIENT_SECRET, fixtures.SHOPIFY_CLIENT_SECRET);
      if (workflow === "deploy.yml") {
        assert.equal(Object.keys(result).length, 14);
        assert.equal(result.FOREVER_TEE_API_SHARED_SECRET, fixtures.FOREVER_TEE_API_SHARED_SECRET);
        assert.equal(result.WEB_ORIGINS, "https://web.example.invalid");
      } else assert.equal(Object.keys(result).length, 3);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
