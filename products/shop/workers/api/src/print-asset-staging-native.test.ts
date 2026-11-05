import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { unstable_dev } from "wrangler";

it("publishes a staged encoded stream through real workerd BYOB and FixedLengthStream with checksum enforcement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "print-staging-native-"));
  const script = join(directory, "worker.mjs");
  const config = join(directory, "wrangler.json");
  const migration = await readFile(new URL("../drizzle/0038_print_staging.sql", import.meta.url), "utf8");
  await writeFile(config, JSON.stringify({ name: "print-staging-native-test", main: script,
    compatibility_date: "2026-08-12", compatibility_flags: ["nodejs_compat"],
    r2_buckets: [{ binding: "DESIGN_ARTWORK", bucket_name: "print-staging-native-test" }],
    d1_databases: [{ binding: "DB", database_name: "print-staging-native-test", database_id: "00000000-0000-0000-0000-000000000001" }] }));
  await writeFile(script, `
    import { createPrintStagingSession, publishStagedPrint, PRINT_MEMORY_TAIL_BYTES } from ${JSON.stringify(new URL("./print-asset-staging.ts", import.meta.url).pathname)};
    import { printBufferAdmission } from ${JSON.stringify(new URL("./print-asset-memory.ts", import.meta.url).pathname)};
    export default { async fetch(request, env) {
      const sql = ${JSON.stringify(migration)};
      for (const statement of sql.split('--> statement-breakpoint')) await env.DB.prepare(statement).run();
      const session = createPrintStagingSession(env, 'product', 'asset');
      try {
        const input = new Uint8Array(10 * 1024 * 1024 + 7);
        for (let i = 0; i < input.length; i++) input[i] = i % 251;
        const response = new Response(input);
        const reader = response.body.getReader({ mode: 'byob' });
        reader.releaseLock();
        const staged = await session.write(response.body, input.length);
        await publishStagedPrint(env.DESIGN_ARTWORK, 'verified.png', staged, session.signal);
        const object = await env.DESIGN_ARTWORK.get('verified.png');
        const digest = Array.from(new Uint8Array(object.checksums.sha256), b => b.toString(16).padStart(2, '0')).join('');
        await object.body.cancel();
        let rejectedChecksum = false;
        try { await publishStagedPrint(env.DESIGN_ARTWORK, 'wrong.png', { ...staged, sha256Bytes: new Uint8Array(32) }, session.signal); }
        catch { rejectedChecksum = true; }
        const tailChecks = [];
        for (const size of [PRINT_MEMORY_TAIL_BYTES, PRINT_MEMORY_TAIL_BYTES + 1]) {
          const bytes = input.subarray(0, size);
          const tail = await session.write(new Response(bytes).body, size, true);
          const received = new Uint8Array(await new Response(await tail.stream()).arrayBuffer());
          tailChecks.push(received.length === bytes.length && received.every((byte, index) => byte === bytes[index]));
        }
        const tailReservation = printBufferAdmission.occupied;
        const small = await session.write(new Response(new Uint8Array([1, 2, 3])).body, 32, true);
        const lockedMemoryInput = (await small.stream()).getReader();
        const abandoned = await staged.stream();
        const abandonedReader = abandoned.getReader(); // Images locks an input but never reads it.
        await session.dispose();
        abandonedReader.releaseLock();
        lockedMemoryInput.releaseLock();
        const inventory = await env.DB.prepare('SELECT count(*) AS count FROM print_asset_staging').first();
        return Response.json({ size: object.size, digest, expectedDigest: staged.sha256, rejectedChecksum,
          tailChecks, tailReservation, remainingReservation: printBufferAdmission.occupied,
          memoryOutputs: session.timings.memoryOutputs, stagedOutputs: session.timings.stagedOutputs,
          inventory: inventory.count, stagedObjects: (await env.DESIGN_ARTWORK.list({ prefix: 'print-assets/staging/v1/' })).objects.length });
      } finally { await session.dispose(); }
    } };
  `);
  const worker = await unstable_dev(script, { config, local: true, persist: false, logLevel: "error", port: 0,
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false } });
  try {
    const response = await worker.fetch();
    const result: unknown = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(result).toMatchObject({ size: 10 * 1024 * 1024 + 7, rejectedChecksum: true, inventory: 0, stagedObjects: 0, tailChecks: [true, true],
      tailReservation: 512 * 1024, remainingReservation: 0, memoryOutputs: 2, stagedOutputs: 2 });
    if (typeof result !== "object" || result === null || !("digest" in result) || !("expectedDigest" in result)) throw new Error("Missing checksum result.");
    expect(result.digest).toBe(result.expectedDigest);
  } finally { await worker.stop(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);
