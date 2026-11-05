import { STORY_VIDEO_RENDERER_VERSION } from "./story-video-jobs";
import type { StoryVideoNotificationEnv } from "./story-video-notifications";

interface VideoStatusRow {
  readonly product_id: string;
  readonly colour: string;
  readonly status: string;
  readonly attempt_count: number;
}

// D1 is authoritative. Reading its tiny indexed job set also makes reconnects
// race-free, without a second notification store or lost-event recovery log.
export async function storyVideoEvents(request: Request, db: D1Database, productId: string, notifications: StoryVideoNotificationEnv = {}) {
  const product = await db.prepare(`
    SELECT COALESCE(video_design_revision_id, design_revision_id) AS design_revision_id FROM products
    WHERE id = ? AND status = 'active' AND COALESCE(video_design_revision_id, design_revision_id) IS NOT NULL AND placement_depth > 0
  `).bind(productId).first<{ design_revision_id: string }>();
  if (!product) return new Response(null, { status: 404 });
  const revisionId = product.design_revision_id;
  const headers = {
    "cache-control": "private, no-store, no-transform",
    "content-type": "text/event-stream",
    "x-content-type-options": "nosniff",
    "x-accel-buffering": "no",
  };
  if (request.method === "HEAD") return new Response(null, { headers });
  if (notifications.STORY_VIDEO_NOTIFICATION_MODE === "push" && notifications.STORY_VIDEO_NOTIFICATIONS) {
    try {
      const response = await notifications.STORY_VIDEO_NOTIFICATIONS.getByName(revisionId).fetch(new Request(
        `https://story-video-notifications.internal/events?revision=${revisionId}`, { signal: request.signal },
      ));
      if (response.ok) return response;
      await response.body?.cancel();
    } catch {
      if (request.signal.aborted) throw new Error("Video event subscription aborted.");
    }
    // Connection failures retain the existing D1 polling path.
  }
  const encoder = new TextEncoder();
  let stop: (close?: boolean) => void = () => undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = Date.now() + 55_000;
      const sent = new Map<string, string>();
      const abort = () => { stop(); };
      stop = (close = true) => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        request.signal.removeEventListener("abort", abort);
        if (close) controller.close();
      };
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) { stop(); return; }
      const emit = (event: string, data: unknown) => {
        if (!closed) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      controller.enqueue(encoder.encode(": notification-mode=poll\nretry: 2000\n\n"));
      async function tick() {
        try {
          const rows = await db.prepare(`
            SELECT jobs.product_id, lower(jobs.colour) AS colour,
              jobs.status, jobs.attempt_count
            FROM story_video_jobs AS jobs
            JOIN products ON products.id = jobs.product_id AND products.status = 'active'
              AND COALESCE(products.video_design_revision_id, products.design_revision_id) = jobs.design_revision_id
            WHERE jobs.design_revision_id = ? AND jobs.renderer_version = ?
            LIMIT 4
          `).bind(revisionId, STORY_VIDEO_RENDERER_VERSION).all<VideoStatusRow>();
          if (closed) return;
          for (const row of rows.results) {
            const status = row.status === "ready" ? "ready"
              : row.status === "failed" && row.attempt_count >= 3 ? "unavailable" : "pending";
            const key = `${row.product_id}:${row.colour}`;
            if (sent.get(key) === status) continue;
            sent.set(key, status);
            emit("video", { productId: row.product_id, color: row.colour, status });
          }
          if (rows.results.length === 4 && [...sent.values()].every((status) => status !== "pending")) {
            emit("complete", {});
            stop();
            return;
          }
          if (Date.now() >= deadline) { stop(); return; }
          // Keeps proxies from buffering an otherwise quiet render. The browser
          // holds one connection rather than polling each colour through Vercel.
          controller.enqueue(encoder.encode(": waiting\n\n"));
          timer = setTimeout(() => { void tick(); }, 1_000);
        } catch {
          emit("unavailable", {});
          stop();
        }
      }
      void tick();
    },
    cancel() { stop(false); },
  });
  return new Response(stream, { headers });
}
