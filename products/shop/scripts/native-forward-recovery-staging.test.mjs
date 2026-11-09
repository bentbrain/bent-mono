import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("staging loads using built-in Node and repository modules with package resolution disabled", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (!(specifier.startsWith('node:') || specifier.startsWith('.') || specifier.startsWith('file:')))
        throw Error('External package resolution forbidden: ' + specifier);
      return next(specifier, context);
    } });
    await import(${JSON.stringify(new URL("./native-forward-recovery-staging.mjs", import.meta.url).href)});
  `], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
});

test("canonical Development staging uses protected secrets, encrypted diagnostics and its guarded entrypoint without installs", async () => {
  const workflow = await readFile(new URL("../.github/workflows/native-development.yml", import.meta.url), "utf8");
  assert.equal(workflow, await readFile(new URL("../../../.github/workflows/native-development.yml", import.meta.url), "utf8"));
  assert.match(workflow, /options: \[.*stage-forward-recovery-authority/);
  assert.equal((workflow.match(/NATIVE_FORWARD_RECOVERY_PACKAGE: \$\{\{ inputs.operation == 'stage-forward-recovery-authority' && secrets.SHOP_DEVELOPMENT_FORWARD_RECOVERY_PACKAGE \|\| '' \}\}/g) ?? []).length, 2);
  assert.doesNotMatch(workflow, /inputs\.forward_recovery_package/);
  for (const line of workflow.split("\n").filter(line => line.trim().startsWith("if: inputs.operation")))
    assert.ok(!line.includes("stage-forward-recovery-authority"));
  assert.match(workflow, /environment: Preview/);
  assert.match(workflow, /Require authoritative exact-main monorepo quality/);
  assert.match(workflow, /node --import .\/scripts\/decode-release-dispatch.mjs --import .\/scripts\/public-release-logging.mjs scripts\/native-ci-development.mjs/);
  assert.match(workflow, /Preserve encrypted operational diagnostics/);
  const production = await readFile(new URL("../.github/workflows/native-production.yml", import.meta.url), "utf8");
  assert.ok(!production.includes("stage-forward-recovery-authority"));
  assert.ok(!production.includes("SHOP_DEVELOPMENT_FORWARD_RECOVERY_PACKAGE"));
});
