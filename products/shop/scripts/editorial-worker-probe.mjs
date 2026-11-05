import { setTimeout } from "node:timers/promises";

export async function waitForEditorialWorker(url, token, runId, { request = fetch, pause = () => setTimeout(3000), attempts = 31 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await request(`${url}/health`, { redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${token}` } });
    if (response.ok) {
      const value = await response.json();
      if (value.ready === true && value.runId === runId) return;
      throw Error("Editorial Worker returned a different operation identity.");
    }
    await response.body?.cancel();
    if (![404, 502, 503, 504].includes(response.status)) throw Error(`Editorial Worker readiness HTTP ${response.status}.`);
    if (attempt + 1 < attempts) await pause();
  }
  throw Error("Editorial Worker URL did not become ready before the deadline. No render was requested.");
}

export async function readRenderEvents(response, token) {
  const body = (await response.text()).replaceAll(token, "<REDACTED>");
  if (!response.ok) throw Error(`Synthetic render HTTP ${response.status}: ${body.slice(0, 1000)}`);
  return body.trim().split("\n").map(line => JSON.parse(line));
}

export async function renderEditorialProbe(url, token, runId, { request = fetch, pause = () => setTimeout(3000), attempts = 11 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await request(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(300000),
      headers: { Authorization: `Bearer ${token}` } });
    // Every handler response carries its operation identity, including errors.
    // Never replay a handled request, timeout, ambiguous failure or another run.
    const identity = response.headers.get("x-editorial-operation");
    if (identity === runId) return response;
    if (identity || response.status !== 404 || !response.headers.get("content-type")?.includes("text/html")) {
      await response.body?.cancel();
      throw Error("Editorial render response identity is unconfirmed. The request was not repeated.");
    }
    const body = await response.text();
    if (!body.includes("<title>Page not found</title>") || !body.includes("https://workers.cloudflare.com/favicon.ico")) {
      throw Error("Editorial render returned an unrecognized 404. The request was not repeated.");
    }
    if (attempt + 1 < attempts) await pause();
  }
  throw Error("Editorial render endpoint did not propagate before the deadline.");
}
