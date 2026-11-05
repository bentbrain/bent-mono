import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { it } from "node:test";

it("keeps renderer failure details in server logs", { timeout: 30_000 }, async (context) => {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [new URL("./server.mjs", import.meta.url).pathname], {
    env: { ...process.env, BENCHMARK_TOKEN: "test-render-token", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill();
    await exited;
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { errors += chunk; });
  while (!output.includes("listening")) {
    await once(child.stdout, "data", { signal: AbortSignal.timeout(20_000) });
  }
  const response = await fetch(`http://127.0.0.1:${port}/render`, {
    method: "POST",
    headers: { authorization: "Bearer test-render-token", "content-type": "application/json" },
    body: '{"internalOnlyPath": /private/renderer/source}',
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Story video rendering failed." });
  while (!errors.includes("SyntaxError")) {
    await once(child.stderr, "data", { signal: AbortSignal.timeout(5_000) });
  }
  assert.match(errors, /Story video rendering failed/);
  assert.match(errors, /SyntaxError/);
});
