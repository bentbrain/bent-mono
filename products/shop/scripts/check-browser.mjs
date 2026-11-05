import { protectedConfig } from "./protected-config.mjs";
import { spawnSync } from "node:child_process";
import { taskRuntimeKey } from "./task-runtime.mjs";
export const browserRuntimeKey = taskRuntimeKey;
export function trustedBrowserRemote(env) {
    return env.GITHUB_ACTIONS === "true" && env.GITHUB_REF === "refs/heads/main" &&
        env.GITHUB_REPOSITORY_ID === protectedConfig("githubRepositoryId") && env.GITHUB_REPOSITORY_OWNER_ID === protectedConfig("githubOwnerId") &&
        env.GITHUB_EVENT_NAME === "workflow_dispatch" && env.GITHUB_RUN_ATTEMPT === "1" &&
        Boolean(env.TURBO_TOKEN && env.TURBO_TEAM);
}
export function browserCheckArgs(env = process.env) {
    // Turbo 2.8 forbids combining --force with --cache. Write-only cache mode
    // executes every task without reading local or remote cached results.
    const fresh = env.CI_FRESH_VALIDATION === "true" || env.E2E_LOCAL_PRODUCTION === "1";
    return ["run", "turbo", "run", "test:e2e:local", "--filter=@forever-tee/web",
        "--cache-dir=.turbo/cache", fresh ? "--cache=local:w" : trustedBrowserRemote(env) ? "--cache=local:rw,remote:rw" : "--cache=local:rw",
        "--summarize"];
}
if (import.meta.main) {
    const args = browserCheckArgs();
    const windows = process.platform === "win32";
    const result = spawnSync(windows ? "cmd.exe" : "bun", windows ? ["/d", "/s", "/c", "bun", ...args] : args, {
        env: { ...process.env, CI_BROWSER_RUNTIME: browserRuntimeKey(), CI_TASK_RUNTIME: taskRuntimeKey() }, stdio: "inherit",
    });
    if (result.error)
        console.error(`Unable to start browser checks: ${result.error.message}`);
    process.exit(result.status ?? 1);
}
