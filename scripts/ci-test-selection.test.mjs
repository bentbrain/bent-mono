import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  playwrightFileFilters,
  selectTestFiles,
  testMapSnapshot,
  testSelectionContext,
} from "./ci-test-selection.mjs";

const app = "apps/jp";
const footer = "src/components/Footer.astro";
const parser = "src/lib/parser.ts";
const mapped = {
  [footer]: { browser: ["footer.spec.ts"] },
  [parser]: { browser: ["editor.spec.ts"], test: ["tests/parser.test.ts"] },
};
const paths = [
  footer,
  parser,
  "tests/browser/footer.spec.ts",
  "tests/browser/editor.spec.ts",
  "tests/browser/map.spec.ts",
  "tests/parser.test.ts",
];
const mapPath = "scripts/ci-test-map.json";

function fixture(t, footerSource = "test fixture") {
  const cwd = mkdtempSync(join(tmpdir(), "ci-selection-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const write = (path, contents = "test fixture") => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), contents);
  };
  const commit = () => {
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-qm", "fixture");
    return git("rev-parse", "HEAD").trim();
  };
  git("init", "-q");
  for (const path of paths)
    write(`${app}/${path}`, path === footer ? footerSource : undefined);
  write("bun.lock");
  write(`${app}/playwright.config.mjs`);
  const input = commit();
  const snapshot = (directory, revision) => testMapSnapshot(directory, revision, git);
  const map = (sources = mapped) => write(mapPath, JSON.stringify({
    schemaVersion: 1,
    applications: { [app]: { fingerprint: snapshot(app, input).fingerprint, sources } },
  }));
  const select = (task, base, head, eventName = "pull_request") => {
    write(".git/event.json", JSON.stringify({ pull_request: { base: { sha: base } } }));
    const context = testSelectionContext({
      GITHUB_EVENT_NAME: eventName,
      GITHUB_SHA: head,
      GITHUB_EVENT_PATH: join(cwd, ".git/event.json"),
    }, git);
    return selectTestFiles(app, task, context, snapshot);
  };
  return { input, git, write, commit, map, select };
}

test("the base map selects browser files and includes added and changed specs", (t) => {
  const { write, commit, map, select } = fixture(t);
  map();
  const base = commit();
  write(`${app}/${footer}`, "changed footer");
  write(`${app}/tests/browser/editor.spec.ts`, "changed editor spec");
  write(`${app}/tests/browser/new.spec.ts`);
  const head = commit();
  const plan = select("browser", base, head);
  assert.deepEqual(plan.files, [
    "tests/browser/editor.spec.ts",
    "tests/browser/footer.spec.ts",
    "tests/browser/new.spec.ts",
  ]);
  assert.deepEqual(plan.details, [
    "- `tests/browser/editor.spec.ts` (new or changed test)",
    "- `tests/browser/footer.spec.ts` (src/components/Footer.astro)",
    "- `tests/browser/new.spec.ts` (new or changed test)",
  ]);
  const filter = new RegExp(playwrightFileFilters(plan.files)[1], "i");
  assert.match("/runner/repo/apps/jp/tests/browser/footer.spec.ts", filter);
  assert.doesNotMatch("/runner/repo/apps/jp/tests/browser/footerXspec.ts", filter);
  assert.doesNotMatch("/runner/repo/apps/jp/tests/browser/old-footer.spec.ts", filter);
});

test("unit selection unions mapped and changed files while integration stays at workspace scope", (t) => {
  const { write, commit, map, select } = fixture(t);
  map();
  const base = commit();
  write(`${app}/${parser}`, "changed parser");
  write(`${app}/tests/other.test.ts`);
  const head = commit();
  assert.deepEqual(select("test", base, head).files, ["tests/other.test.ts", "tests/parser.test.ts"]);
  assert.deepEqual(select("browser", base, head).files, ["tests/browser/editor.spec.ts"]);
  assert.equal(select("test:integration", base, head).files, null);
});

test("a tracking-only mapping keeps destination, markup and layout on the full suite", (t) => {
  const source = [
    '<a class="w-auto"',
    '  href="https://shop.bent.build/?utm_source=jp.bent.build&utm_medium=blog"',
    '>shop</a>',
  ].join("\n");
  const { write, commit, map, select } = fixture(t, source);
  map({ [footer]: { browser: ["footer.spec.ts"], trackingValuesOnly: true } });
  const base = commit();
  const trackingEdit = source.replace("utm_medium=blog", "utm_medium=ci-demo");
  write(`${app}/${footer}`, trackingEdit);
  assert.deepEqual(select("browser", base, commit()).files, ["tests/browser/footer.spec.ts"]);
  for (const change of [
    trackingEdit.replace("w-auto", "w-[40rem]"),
    trackingEdit.replace("https://shop.bent.build/", "https://shop.bent.build/featured/"),
    trackingEdit.replace(">shop<", ">shop the collection<"),
  ]) {
    write(`${app}/${footer}`, change);
    const plan = select("browser", base, commit());
    assert.equal(plan.files, null);
    assert.match(plan.reason, /outside the reviewed link tracking values/);
  }
});

test("a standalone spec change runs that spec", (t) => {
  const { write, commit, map, select } = fixture(t);
  map();
  const base = commit();
  write(`${app}/tests/browser/map.spec.ts`, "changed map spec");
  assert.deepEqual(select("browser", base, commit()).files, ["tests/browser/map.spec.ts"]);
});

test("config, fixtures, global files and unknown changes run the full suite", (t) => {
  for (const path of [
    `${app}/playwright.config.mjs`,
    `${app}/tests/fixtures/state.ts`,
    `${app}/src/layouts/Site.astro`,
    `${app}/src/styles/globals.css`,
    `${app}/src/middleware.ts`,
    `${app}/src/worker.ts`,
    `${app}/wrangler.toml`,
    `${app}/astro.config.mjs`,
    `${app}/vite.config.ts`,
    `${app}/migrations/change.sql`,
    `${app}/src/components/Other.astro`,
    `${app}/package.json`,
    "bun.lock",
    "packages/ui/src/button.tsx",
    "scripts/ci-check.mjs",
  ]) {
    const { write, commit, map, select } = fixture(t);
    map();
    const base = commit();
    write(`${app}/${footer}`, "changed footer");
    write(path, "changed input");
    assert.equal(select("browser", base, commit()).files, null, path);
  }
});

test("deleted tests and deleted mapped inputs widen the suite", (t) => {
  for (const path of ["tests/browser/footer.spec.ts", footer]) {
    const { git, commit, map, select } = fixture(t);
    map();
    const base = commit();
    git("rm", `${app}/${path}`);
    assert.equal(select("browser", base, commit()).files, null, path);
  }
});

test("a missing, edited or unreadable map runs the full suite", (t) => {
  const { write, commit, input, select } = fixture(t);
  write(`${app}/${footer}`, "changed footer");
  const head = commit();
  assert.match(select("browser", input, head).reason, /missing or unreadable/);

  write(mapPath, "invalid JSON");
  const malformed = commit();
  assert.match(select("browser", head, malformed).reason, /map changed/);
  write(`${app}/${footer}`, "second change");
  assert.match(select("browser", malformed, commit()).reason, /missing or unreadable/);
});

test("an invalid map entry cannot select tests", (t) => {
  const { write, commit, map, select } = fixture(t);
  map({ [footer]: { browser: ["missing.spec.ts"] } });
  const base = commit();
  write(`${app}/${footer}`, "changed footer");
  assert.match(select("browser", base, commit()).reason, /invalid entry/);
});

test("a stale lockfile or configuration invalidates the map even after merge to the base", (t) => {
  for (const path of ["bun.lock", `${app}/playwright.config.mjs`]) {
    const { write, commit, map, select } = fixture(t);
    map();
    write(path, "new base contents");
    const base = commit();
    write(`${app}/${footer}`, "changed footer");
    assert.match(select("browser", base, commit()).reason, /stale/);
  }
});

test("wrong checkout, missing history and non-PR events run the full suite", (t) => {
  const { write, commit, map, select } = fixture(t);
  map();
  const base = commit();
  write(`${app}/${footer}`, "changed footer");
  const head = commit();
  assert.match(select("browser", base, base).reason, /checkout/);
  assert.match(select("browser", "f".repeat(40), head).reason, /unavailable/);
  for (const event of ["push", "schedule", "workflow_dispatch", "merge_group"])
    assert.match(select("browser", base, head, event).reason, /pull requests only/);
});
