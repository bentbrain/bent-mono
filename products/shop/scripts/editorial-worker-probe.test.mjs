import test from "node:test";
import assert from "node:assert/strict";
import { waitForEditorialWorker, readRenderEvents } from "./editorial-worker-probe.mjs";
const url = "https://probe.example", token = "private-token", runId = "12345";
test("a new probe can propagate before a render is sent, using only authenticated GETs", async () => {
  const statuses = [404, 503, 200], calls = [];
  await waitForEditorialWorker(url, token, runId, { pause: async () => {}, request: async (target, options) => {
    calls.push({ target, options });
    const status = statuses.shift();
    return new Response(status === 200 ? JSON.stringify({ ready: true, runId }) : "pending", { status });
  } });
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.target, `${url}/health`);
    assert.equal(call.options.method, undefined);
    assert.equal(call.options.headers.Authorization, `Bearer ${token}`);
  }
});
test("wrong secrets, wrong identities and unready URLs never advance to rendering", async () => {
  for (const response of [new Response(null, { status: 401 }), Response.json({ ready: true, runId: "other" })]) {
    await assert.rejects(waitForEditorialWorker(url, token, runId, { request: async () => response, pause: async () => {} }));
  }
  let count = 0;
  await assert.rejects(waitForEditorialWorker(url, token, runId, { attempts: 2, pause: async () => {}, request: async () => {
    count++; return new Response(null, { status: 404 });
  } }), /No render was requested/);
  assert.equal(count, 2);
});
test("render errors retain bounded HTTP details without exposing the probe secret", async () => {
  await assert.rejects(readRenderEvents(new Response(`failure ${token}`, { status: 503 }), token),
    { message: "Synthetic render HTTP 503: failure <REDACTED>" });
  assert.deepEqual(await readRenderEvents(new Response('{"type":"started"}\n{"type":"complete","count":1}\n'), token),
    [{ type: "started" }, { type: "complete", count: 1 }]);
});

test("rendering tolerates only an explicit pre-handler Cloudflare missing-Worker page", async () => {
  const { renderEditorialProbe } = await import("./editorial-worker-probe.mjs");
  let calls = 0;
  const response = await renderEditorialProbe(url, token, runId, { pause: async () => {}, request: async () => {
    calls++;
    return calls === 1 ? new Response('<title>Page not found</title><link href="https://workers.cloudflare.com/favicon.ico">', { status: 404, headers: { "content-type": "text/html" } })
      : new Response('{"type":"complete","count":1}', { headers: { "x-editorial-operation": runId } });
  } });
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
});

test("handled errors and uncertain responses never repeat a render", async () => {
  const { renderEditorialProbe } = await import("./editorial-worker-probe.mjs");
  for (const response of [
    new Response("render failed", { status: 404, headers: { "x-editorial-operation": runId } }),
    new Response("unknown", { status: 502 }),
    new Response("unknown", { status: 404, headers: { "content-type": "text/html" } }),
    new Response("other run", { headers: { "x-editorial-operation": "other" } }),
  ]) {
    let calls = 0;
    const result = renderEditorialProbe(url, token, runId, { request: async () => { calls++; return response; } });
    if (response.headers.get("x-editorial-operation") === runId) assert.equal(await result, response);
    else await assert.rejects(result, /not repeated/);
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(renderEditorialProbe(url, token, runId, { request: async () => { calls++; throw Error("timeout"); } }), /timeout/);
  assert.equal(calls, 1);
});
