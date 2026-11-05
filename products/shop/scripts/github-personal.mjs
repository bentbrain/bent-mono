import { protectedConfig } from "./protected-config.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const execute = promisify(execFile);
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const REPOSITORY = "bentbrain/bent-mono";
export async function personalGitHub({ run = execute, request = fetch, environment = process.env } = {}) {
    const env = Object.fromEntries(["HOME", "PATH", "TMPDIR", "LANG"].filter(key => environment[key]).map(key => [key, environment[key]]));
    let token;
    try {
        token = (await run("gh", ["auth", "token", "--hostname", "github.com", "--user", "bentbrain"], { cwd: ROOT, env, encoding: "utf8" })).stdout.trim();
    }
    catch {
        throw new Error("Personal bentbrain GitHub authentication is unavailable.");
    }
    const api = async (path, { method = "GET", body } = {}) => {
        if (path !== "/user" && !path.startsWith(`/repos/${REPOSITORY}/`) && path !== `/repos/${REPOSITORY}`) {
            throw new Error("GitHub requests must stay within the personal repository.");
        }
        if (/[?#]|\.\.|%|\\/.test(path))
            throw new Error("GitHub path overrides are forbidden.");
        let response;
        try {
            response = await request(`https://api.github.com${path}`, { method, redirect: "error", signal: AbortSignal.timeout(30000),
                headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        }
        catch {
            throw new Error("Personal GitHub request failed before a confirmed response; inspect remote state before retrying writes.");
        }
        if (!response.ok)
            throw new Error(`Personal GitHub ${method} request failed with HTTP ${response.status}.`);
        return response.status === 204 ? null : response.json();
    };
    const user = await api("/user");
    if (user.login !== "bentbrain" || user.id !== Number(protectedConfig("githubOwnerId")))
        throw new Error("GitHub identity is not personal bentbrain.");
    const repo = await api(`/repos/${REPOSITORY}`);
    if (repo.id !== Number(protectedConfig("githubRepositoryId")) || repo.owner?.id !== Number(protectedConfig("githubOwnerId")) || repo.full_name !== REPOSITORY)
        throw new Error("Personal GitHub repository identity mismatch.");
    return { api, repository: repo,
        // Read-only migration discovery. The old repository is an explicit
        // protected prerequisite, never inferred from a role's current subject.
        trustRead: async path => {
            const url = new URL(path, "https://api.github.com");
            const old = protectedConfig("trustOriginalRepository");
            if (!/^bentbrain\/[A-Za-z0-9._-]+$/.test(old) || old === REPOSITORY ||
                url.origin !== "https://api.github.com" || url.username || url.password || url.hash || /%|\\|\.\./.test(path) ||
                ![REPOSITORY, old].some(name => url.pathname === `/repos/${name}` || url.pathname.startsWith(`/repos/${name}/`)))
                throw new Error("Trust discovery must stay within the two exact personal repositories.");
            const response = await request(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(30000),
                headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } });
            if (!response.ok) throw new Error(`Trust discovery failed with HTTP ${response.status}.`);
            return response.json();
        }, setProductionNativeSecret: async (name, value) => {
            const formats = { STORY_VIDEO_LAMBDA_ACCESS_KEY_ID: /^AKIA[A-Z0-9]{16}$/, STORY_VIDEO_LAMBDA_SECRET_ACCESS_KEY: /^[A-Za-z0-9+/]{40}$/,
                STORY_VIDEO_GRANT_SECRET: /^[A-Za-z0-9_-]{43}$/ };
            if (!Object.hasOwn(formats, name) || typeof value !== "string" || !formats[name].test(value))
                throw new Error("Invalid fixed Production native secret.");
            try {
                const pending = run("gh", ["secret", "set", name, "--repo", REPOSITORY, "--env", "Production"], {
                    cwd: ROOT, env: { ...env, GH_TOKEN: token }, encoding: "utf8", timeout: 30000,
                });
                pending.child.stdin.end(value);
                await pending;
            }
            catch {
                throw new Error(`Production ${name} transfer response uncertain; preserve the recovery file and inspect before resuming.`);
            }
            return { name, transferred: true };
        }, setProductionAlertEmail: async (value) => {
            if (typeof value !== "string" || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
                throw new Error("A valid owner-provided alert email is required.");
            try {
                const pending = run("gh", ["secret", "set", "NATIVE_ALERT_EMAIL", "--repo", REPOSITORY, "--env", "Production"], {
                    cwd: ROOT, env: { ...env, GH_TOKEN: token }, encoding: "utf8", timeout: 30000,
                });
                pending.child.stdin.end(value);
                await pending;
            }
            catch {
                throw new Error("Production alert secret response uncertain; inspect secret metadata before retrying. No contact value logged.");
            }
            return { productionAlertEmailConfigured: true };
        }, readyNativePullRequest: async (expectedHead, number = 117) => {
            if (!/^[a-f0-9]{40}$/.test(expectedHead ?? "") || !Number.isSafeInteger(number) || number <= 0)
                throw new Error("Expected exact reviewed pull request and head.");
            const pull = await api(`/repos/${REPOSITORY}/pulls/${number}`);
            if (pull.state !== "open" || pull.head?.sha !== expectedHead || pull.head.ref !== "perf/story-video-family-experiments" ||
                pull.head.repo?.id !== Number(protectedConfig("githubRepositoryId")) || pull.base?.repo?.id !== Number(protectedConfig("githubRepositoryId")) || pull.base.ref !== "main") {
                throw new Error("Native pull request changed; no review-state mutation attempted.");
            }
            if (!pull.draft)
                return { ready: true, alreadyReady: true, head: expectedHead };
            try {
                await run("gh", ["pr", "ready", String(number), "--repo", REPOSITORY], {
                    cwd: ROOT, env: { ...env, GH_TOKEN: token }, encoding: "utf8", timeout: 30000,
                });
            }
            catch {
                throw new Error("Personal pull-request readiness response uncertain; inspect before retrying.");
            }
            const after = await api(`/repos/${REPOSITORY}/pulls/${number}`);
            if (after.draft || after.state !== "open" || after.head?.sha !== expectedHead)
                throw new Error("Pull-request state changed during readiness verification.");
            return { ready: true, head: expectedHead };
        }, jobLog: async (jobId) => {
            if (!Number.isSafeInteger(jobId) || jobId <= 0)
                throw new Error("Invalid personal repository job ID.");
            try {
                return (await run("gh", ["api", `repos/${REPOSITORY}/actions/jobs/${jobId}/logs`], {
                    cwd: ROOT, env: { ...env, GH_TOKEN: token }, encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024,
                })).stdout;
            }
            catch {
                throw new Error("Personal GitHub job log unavailable.");
            }
        }, push: async () => {
            const { stdout } = await run("git", ["branch", "--show-current"], { cwd: ROOT, env, encoding: "utf8" });
            if (stdout.trim() !== "perf/story-video-family-experiments")
                throw new Error("Refusing to push a different branch.");
            try {
                await run("git", ["push", "https://github.com/bentbrain/bent-mono.git", "HEAD:refs/heads/perf/story-video-family-experiments"], {
                    cwd: ROOT, encoding: "utf8", timeout: 120000,
                    env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "2",
                        GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "",
                        GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` },
                });
            }
            catch {
                throw new Error("Personal GitHub push failed; verify the remote ref before retrying. No force push attempted.");
            }
        } };
}
