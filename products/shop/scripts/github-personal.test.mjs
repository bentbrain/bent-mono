import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { personalGitHub } from "./github-personal.mjs";
const repository = { id: Number(protectedConfig("githubRepositoryId")), owner: { id: Number(protectedConfig("githubOwnerId")) }, full_name: "bentbrain/bent-mono" };
test("native Production secrets use stdin, fixed destinations and sanitized failures", async () => {
    const values = { STORY_VIDEO_LAMBDA_ACCESS_KEY_ID: `AKIA${"A".repeat(16)}`, STORY_VIDEO_LAMBDA_SECRET_ACCESS_KEY: "B".repeat(40),
        STORY_VIDEO_GRANT_SECRET: "C".repeat(43) };
    let sent, fail = false;
    const github = await personalGitHub({ environment: { GH_TOKEN: "work", GITHUB_TOKEN: "work" }, run: (command, args, options) => {
            assert.equal(command, "gh");
            if (args[0] === "auth")
                return Promise.resolve({ stdout: "personal-fixture" });
            assert.deepEqual(args, ["secret", "set", args[2], "--repo", "bentbrain/bent-mono", "--env", "Production"]);
            assert.ok(Object.hasOwn(values, args[2]));
            assert.equal(options.env.GH_TOKEN, "personal-fixture");
            assert.equal(options.env.GITHUB_TOKEN, undefined);
            const pending = fail ? Promise.reject(new Error(values[args[2]])) : Promise.resolve({ stdout: "" });
            return Object.assign(pending, { child: { stdin: { end: value => { sent = value; } } } });
        }, request: async (url) => Response.json(url.endsWith("/user") ? { login: "bentbrain", id: Number(protectedConfig("githubOwnerId")) } : repository) });
    for (const [name, value] of Object.entries(values)) {
        await github.setProductionNativeSecret(name, value);
        assert.equal(sent, value);
    }
    await assert.rejects(github.setProductionNativeSecret("UNRELATED", "anything"));
    await assert.rejects(github.setProductionNativeSecret("STORY_VIDEO_GRANT_SECRET", "short"));
    fail = true;
    await assert.rejects(github.setProductionNativeSecret("STORY_VIDEO_LAMBDA_SECRET_ACCESS_KEY", values.STORY_VIDEO_LAMBDA_SECRET_ACCESS_KEY), error => /uncertain/.test(error.message) && !error.message.includes(values.STORY_VIDEO_LAMBDA_SECRET_ACCESS_KEY));
});
test("personal GitHub ignores inherited tokens and verifies identity before returning any write capability", async () => {
    const calls = [];
    const github = await personalGitHub({ environment: { GH_TOKEN: "work", GITHUB_TOKEN: "work" },
        run: async (command, args, options) => { assert.equal(command, "gh"); assert.ok(args.includes("bentbrain")); assert.equal(options.env.GH_TOKEN, undefined); return { stdout: "personal-fixture" }; },
        request: async (url, init) => {
            calls.push([url, init.method]);
            assert.equal(init.headers.Authorization, "Bearer personal-fixture");
            assert.equal(init.redirect, "error");
            return Response.json(url.endsWith("/user") ? { login: "bentbrain", id: Number(protectedConfig("githubOwnerId")) } : repository);
        },
    });
    assert.equal(calls.length, 2);
    await assert.rejects(github.api("/repos/work/other"), /personal repository/);
    await assert.rejects(github.api("/repos/bentbrain/bent-mono/../other"), /overrides/);
});
test("wrong GitHub identity makes no repository request and cannot expose credentials through errors", async () => {
    let calls = 0;
    await assert.rejects(personalGitHub({ run: async () => ({ stdout: "private-fixture" }), request: async () => { calls++; return Response.json({ login: "work", id: 1 }); } }), /not personal/);
    assert.equal(calls, 1);
    await assert.rejects(personalGitHub({ run: async () => { throw new Error("private-fixture"); } }), error => !error.message.includes("private-fixture"));
});
test("Production alert email is sent only over stdin using verified personal GitHub credentials", async () => {
    let contact;
    const github = await personalGitHub({ environment: { GH_TOKEN: "work" },
        run: (command, args, options) => {
            if (args[0] === "auth")
                return Promise.resolve({ stdout: "personal-fixture" });
            assert.deepEqual(args, ["secret", "set", "NATIVE_ALERT_EMAIL", "--repo", "bentbrain/bent-mono", "--env", "Production"]);
            assert.equal(options.env.GH_TOKEN, "personal-fixture");
            return Object.assign(Promise.resolve({ stdout: "" }), { child: { stdin: { end: value => { contact = value; } } } });
        }, request: async (url) => Response.json(url.endsWith("/user") ? { login: "bentbrain", id: Number(protectedConfig("githubOwnerId")) } : repository),
    });
    await assert.rejects(github.setProductionAlertEmail("bad\ninput"));
    assert.equal((await github.setProductionAlertEmail("owner@example.com")).productionAlertEmailConfigured, true);
    assert.equal(contact, "owner@example.com");
});
test("readiness targets only the verified native PR and expected head with personal authentication", async () => {
    let draft = true, writes = 0;
    const head = "a".repeat(40);
    const github = await personalGitHub({ environment: { GH_TOKEN: "work" },
        run: async (command, args, options) => {
            assert.equal(command, "gh");
            if (args[0] === "auth") {
                assert.equal(options.env.GH_TOKEN, undefined);
                return { stdout: "personal-fixture" };
            }
            assert.deepEqual(args, ["pr", "ready", "117", "--repo", "bentbrain/bent-mono"]);
            assert.equal(options.env.GH_TOKEN, "personal-fixture");
            writes++;
            draft = false;
            return { stdout: "" };
        }, request: async (url) => Response.json(url.endsWith("/user") ? { login: "bentbrain", id: Number(protectedConfig("githubOwnerId")) } : url.endsWith("/pulls/117") ? {
            state: "open", draft, head: { sha: head, ref: "perf/story-video-family-experiments", repo: repository }, base: { ref: "main", repo: repository },
        } : repository),
    });
    await assert.rejects(github.readyNativePullRequest("b".repeat(40)), /changed/);
    assert.equal(writes, 0);
    await assert.rejects(github.readyNativePullRequest(head, "117/merge"), /exact reviewed/);
    assert.equal(writes, 0);
    assert.equal((await github.readyNativePullRequest(head)).ready, true);
    assert.equal(writes, 1);
    assert.equal((await github.readyNativePullRequest(head)).alreadyReady, true);
    assert.equal(writes, 1);
});
