// The queue admits one design family at a time. Each lane owns one container
// and runs at most one encode, so FFmpeg processes never compete in a container.
export async function runBatch({ jobs, concurrency, cached, render, ready }) {
  const pending = [];
  const results = [];
  const failures = [];
  async function publish(result) {
    results.push(result);
    await ready(result);
  }
  await Promise.all(jobs.map(async (job) => {
    const result = await cached(job);
    if (result) await publish(result);
    else pending.push(job);
  }));
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async (_, lane) => {
    while (next < pending.length) {
      const job = pending[next++];
      try {
        await publish(await render(job, lane));
      } catch (error) {
        failures.push({ key: job.key, error: String(error) });
      }
    }
  }));
  return { results, failures };
}

export function streamingBatch(run) {
  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event) => {
        if (!cancelled) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      emit({ type: "started" });
      try {
        const result = await run((item) => emit({ type: "ready", ...item }));
        if (result.failures.length) {
          emit({ type: "error", error: "Some videos could not be rendered.", failures: result.failures });
        } else {
          emit({ type: "complete", count: result.results.length });
        }
      } catch (error) {
        emit({ type: "error", error: String(error) });
      } finally {
        if (!cancelled) controller.close();
      }
    },
    cancel() { cancelled = true; },
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
  });
}
