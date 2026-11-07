import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
) {
  const full =
    environment.GITHUB_EVENT_NAME === "schedule" ||
    environment.GITHUB_EVENT_NAME === "workflow_dispatch";
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
      const files = execute(
        "git",
        ["diff", "--name-only", "-z", "--no-renames", range.base, range.head],
        { encoding: "utf8" },
      )
        .split("\0")
        .filter(Boolean);
      // Root automation/configuration affects every product. Product-level Shop
      // scripts and relative renderer imports also require all Shop consumers.
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
        if (
          files.some((file) => file.startsWith("products/shop/")) ||
          selected.some((item) => item.path.startsWith("products/shop"))
        ) {
          selected = all.filter(
            (item) =>
              item.path.startsWith("products/shop") ||
              selected.some((affected) => affected.name === item.name),
          );
        }
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const scope = workspaceScope();
  console.log(JSON.stringify(scope));
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      ["apps/jp", "apps/trackmap", "products/shop"]
        .map(
          (directory) =>
            `${directory.split("/").at(-1)}=${includesPath(scope, directory)}`,
        )
        .concat(`full=${scope.full}`)
        .join("\n") + "\n",
    );
}
