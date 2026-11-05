import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { promisify } from "node:util";

it("stores remote benchmark videos in separate private run directories", async context => {
  const fixture = await mkdtemp(join(tmpdir(), "story-benchmark-test-"));
  const directories = new Set();
  context.after(async () => {
    await Promise.all([...directories, fixture].map(path => rm(path, { recursive: true, force: true })));
  });
  const artwork = join(fixture, "artwork.png");
  await writeFile(artwork, "synthetic artwork");
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    if (request.url === "/health" || request.url === "/render-batch" || request.url === "/batch-state") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, state: { status: "stopped" } }));
    } else if (request.url === "/render") {
      response.setHeader("content-type", "video/mp4");
      response.end("synthetic video");
    } else {
      response.writeHead(404).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const execute = promisify(execFile);
  const outputPaths = [];
  for (const script of ["benchmark-remote.mjs", "benchmark-remote.mjs", "benchmark-batch-remote.mjs"]) {
    const { stdout } = await execute(process.execPath, [new URL(`./${script}`, import.meta.url).pathname], {
      env: { ...process.env, REMOTE_BENCHMARK_URL: `http://127.0.0.1:${address.port}`,
        REMOTE_BENCHMARK_TOKEN: "synthetic-local-token", STORY_ARTWORK: artwork,
        STORY_BENCHMARK_SCENARIO: "single", STORY_WARM_ITERATIONS: "1", STORY_BENCHMARK_R2: "0",
        STORY_BENCHMARK_REPORT: "" },
    });
    const report = JSON.parse(stdout);
    const outputs = script === "benchmark-remote.mjs" ? report.warm : report.cached;
    assert.equal(outputs.length, script === "benchmark-remote.mjs" ? 1 : 4);
    const directory = dirname(outputs[0].output);
    assert.equal(directories.has(directory), false, "Each invocation owns a fresh output directory.");
    directories.add(directory);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    for (const { output } of outputs) {
      assert.equal(dirname(output), directory);
      assert.equal(await readFile(output, "utf8"), "synthetic video");
      outputPaths.push(output);
    }
  }
  assert.equal(new Set(outputPaths).size, 6);
});
