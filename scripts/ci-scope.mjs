import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const browserShardCounts = {
  fitness: 1,
  trackmap: 1,
  jp: 4,
  toolbar: 3,
  home: 1,
};

// These app-root files are repository and package documentation. JP and
// Toolbar both exclude their README and LICENSE from Tailwind's scan.
// Keep served content, fixtures and other Markdown in the normal scope.
const browserDocumentation = new Set([
  "apps/jp/README.md",
  "apps/jp/LICENSE",
  "apps/toolbar/README.md",
  "apps/toolbar/LICENSE",
]);

function documentationOnly(files, readDiff) {
  if (!files.length || !files.every((path) => browserDocumentation.has(path)))
    return false;

  // A documentation path can also be a symlink or a submodule. Only ordinary
  // files and their additions/deletions qualify for this exemption.
  const records = readDiff("--raw").split("\0");
  return (
    records.length === files.length * 2 + 1 &&
    files.every((path, index) => {
      const [modes, recordPath] = records.slice(index * 2, index * 2 + 2);
      return (
        recordPath === path &&
        /^:(?:100644|000000) (?:100644|000000) /.test(modes)
      );
    })
  );
}

export function comparison(eventName, event, head) {
  const base =
    eventName === "pull_request"
      ? event.pull_request?.base?.sha
      : eventName === "push"
        ? event.before
        : eventName === "merge_group"
          ? event.merge_group?.base_sha
          : null;
  return /^[a-f0-9]{40}$/.test(base ?? "") &&
    !/^0+$/.test(base) &&
    /^[a-f0-9]{40}$/.test(head ?? "")
    ? { base, head }
    : null;
}

// Turbo owns lockfile resolution and the transitive workspace dependency graph.
// Missing history or an unrecognised event must widen checks, never skip them.
export function workspaceScope(
  environment = process.env,
  execute = execFileSync,
  { browser = false } = {},
) {
  const full =
    environment.GITHUB_EVENT_NAME === "schedule" ||
    environment.GITHUB_EVENT_NAME === "workflow_dispatch" ||
    (browser &&
      environment.GITHUB_EVENT_NAME === "push" &&
      environment.GITHUB_REF === "refs/heads/main");
  const turbo = resolve("node_modules/.bin/turbo");
  function inventory(args, extraEnvironment = {}) {
    const result = JSON.parse(
      execute(turbo, ["ls", ...args, "--output=json"], {
        encoding: "utf8",
        env: {
          ...environment,
          TURBO_TELEMETRY_DISABLED: "1",
          ...extraEnvironment,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    if (
      !Array.isArray(result.packages?.items) ||
      result.packages.items.some(
        (item) =>
          typeof item.name !== "string" || typeof item.path !== "string",
      )
    )
      throw new Error("Invalid Turbo workspace inventory");
    return result.packages.items;
  }
  const all = inventory([]);
  let selected = all;
  let reason = "complete workspace validation";
  try {
    const event = environment.GITHUB_EVENT_PATH
      ? JSON.parse(readFileSync(environment.GITHUB_EVENT_PATH, "utf8"))
      : {};
    const range = comparison(
      environment.GITHUB_EVENT_NAME,
      event,
      environment.GITHUB_SHA,
    );
    if (!full && range) {
      const readDiff = (format) =>
        execute(
          "git",
          ["diff", format, "-z", "--no-renames", range.base, range.head],
          { encoding: "utf8" },
        );
      const files = readDiff("--name-only").split("\0").filter(Boolean);
      if (
        browser &&
        environment.GITHUB_EVENT_NAME === "pull_request" &&
        documentationOnly(files, readDiff)
      ) {
        return { full, packages: [], reason: "app documentation only" };
      }
      // Root automation/configuration affects every product.
      const rootChanged = files.some(
        (file) =>
          file !== "bun.lock" &&
          !all.some((item) => file.startsWith(`${item.path}/`)),
      );
      if (!rootChanged) {
        selected = inventory(["--affected"], {
          TURBO_SCM_BASE: range.base,
          TURBO_SCM_HEAD: range.head,
        });
        // Product-root automation is not a dependency of each nested package.
        // Include those children when their containing workspace is affected.
        const parents = selected;
        selected = all.filter((item) =>
          parents.some(
            (parent) =>
              item.name === parent.name ||
              item.path.startsWith(`${parent.path}/`),
          ),
        );
        reason = "changed workspaces and their consumers";
      }
    }
  } catch (error) {
    console.warn(
      `Affected selection unavailable; checking all workspaces: ${error.message}`,
    );
    selected = all;
  }
  return { full, packages: selected, reason };
}

export function includesPath(scope, directory) {
  return scope.packages.some(
    (item) => item.path === directory || item.path.startsWith(`${directory}/`),
  );
}

export function browserMatrix(scope) {
  return Object.entries(browserShardCounts).flatMap(([app, total]) =>
    includesPath(scope, `apps/${app}`)
      ? Array.from({ length: total }, (_, index) => ({
          app,
          part: index + 1,
          total,
          name: `Browser ${app} (${index + 1}/${total})`,
        }))
      : [],
  );
}

// The native iPhone job builds the app, its Health module and the Fitness
// handlers its round trip calls. Turbo adds their workspace consumers.
const iosNativeWorkspaces = [
  "apps/fitness-ios",
  "packages/fitness-contracts",
  "apps/fitness",
];

// Main pushes leave the native iPhone job to the Fitness iOS Verification
// workflow, which runs it for main pushes that touch the app or its
// dependencies, and daily.
export function mainPush(environment) {
  return (
    environment.GITHUB_EVENT_NAME === "push" &&
    environment.GITHUB_REF === "refs/heads/main"
  );
}

export function iosNativeSelected(scope, environment = {}) {
  if (mainPush(environment)) return false;
  return (
    scope.full ||
    iosNativeWorkspaces.some((directory) => includesPath(scope, directory))
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const scope = workspaceScope(process.env, execFileSync, { browser: true });
  const include = browserMatrix(scope);
  // Main pushes check every browser suite. Other events run the native
  // iPhone job for changes that reach it.
  const iosNative =
    !mainPush(process.env) &&
    iosNativeSelected(workspaceScope(process.env, execFileSync), process.env);
  console.log(JSON.stringify({ browser: scope, iosNative }));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `matrix=${JSON.stringify({ include })}\nhas_work=${include.length > 0}\ntier=${scope.full ? "full" : "critical"}\nios_native=${iosNative}\n`,
    );
  }
}
