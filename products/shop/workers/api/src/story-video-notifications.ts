import { STORY_VIDEO_RENDERER_VERSION } from "./story-video-jobs";

export interface StoryVideoNotificationEnv {
  readonly STORY_VIDEO_NOTIFICATION_MODE?: string;
  readonly STORY_VIDEO_NOTIFICATIONS?: {
    getByName(name: string): { fetch(request: Request): Promise<Response> };
  };
}

interface StatusRow {
  readonly product_id: string;
  readonly colour: string;
  readonly status: string;
  readonly attempt_count: number;
}

const headers = {
  "cache-control": "private, no-store, no-transform", "content-type": "text/event-stream",
  "x-content-type-options": "nosniff", "x-accel-buffering": "no",
};

// D1 remains authoritative. Notifications are invalidations, never a second
// readiness store. Every connection takes a fresh snapshot before settling.
export class StoryVideoNotificationHub {
  private readonly clients = new Set<{ update(rows: readonly StatusRow[]): void; close(): void }>();
  private pending = Promise.resolve();
  private recoveryTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly load: () => Promise<readonly StatusRow[]>) {}

  notify(): Promise<void> {
    if (this.clients.size === 0) return Promise.resolve();
    this.pending = this.pending.then(async () => {
      if (this.clients.size === 0) return;
      const rows = await this.load();
      for (const client of this.clients) client.update(rows);
    }).catch(() => {
      // Reconnect snapshots recover from database/DO failures without losing
      // committed readiness or retrying a completed encode.
      for (const client of this.clients) client.close();
    });
    return this.pending;
  }

  subscribe(request: Request): Response {
    if (this.clients.size >= 32) return new Response(null, { status: 503 });
    const encoder = new TextEncoder();
    let cancel = () => undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let closed = false;
        const sent = new Map<string, string>();
        const close = (end = true) => {
          if (closed) return;
          closed = true;
          clearTimeout(timer);
          request.signal.removeEventListener("abort", abort);
          this.clients.delete(client);
          if (this.clients.size === 0) { clearInterval(this.recoveryTimer); this.recoveryTimer = undefined; }
          if (end) controller.close();
        };
        const abort = () => { close(); };
        const emit = (event: string, data: unknown) => {
          if (!closed) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        const client = { close, update: (rows: readonly StatusRow[]) => {
          for (const row of rows) {
            const status = row.status === "ready" ? "ready"
              : row.status === "failed" && row.attempt_count >= 3 ? "unavailable" : "pending";
            const key = `${row.product_id}:${row.colour}`;
            if (sent.get(key) === status) continue;
            sent.set(key, status);
            emit("video", { productId: row.product_id, color: row.colour, status });
          }
          if (rows.length === 4 && rows.every((row) => row.status === "ready" || row.status === "failed" && row.attempt_count >= 3)) {
            emit("complete", {});
            close();
          } else if (!closed) controller.enqueue(encoder.encode(": waiting\n\n"));
        } };
        const timer = setTimeout(close, 55_000);
        cancel = () => { close(false); };
        this.clients.add(client);
        request.signal.addEventListener("abort", abort, { once: true });
        if (request.signal.aborted) { close(); return; }
        controller.enqueue(encoder.encode(": notification-mode=push\nretry: 2000\n\n"));
        // One recovery read per family, not one per client. Covers missed
        // notifications and terminal failures, and stops with the last client.
        this.recoveryTimer ??= setInterval(() => { void this.notify(); }, 10_000);
        void this.notify();
      },
      cancel: () => { cancel(); },
    });
    return new Response(stream, { headers });
  }
}

export class StoryVideoNotifications {
  private hub: StoryVideoNotificationHub | undefined;
  private revision: string | undefined;
  constructor(_state: DurableObjectState, private readonly env: { DB: D1Database }) {}

  fetch(request: Request): Response | Promise<Response> {
    const url = new URL(request.url);
    const revision = url.searchParams.get("revision") ?? "";
    if (!/^[0-9a-f-]{36}$/.test(revision) || this.revision !== undefined && this.revision !== revision) {
      return new Response(null, { status: 400 });
    }
    this.revision = revision;
    this.hub ??= new StoryVideoNotificationHub(async () => {
      const result = await this.env.DB.prepare(`
        SELECT jobs.product_id, lower(jobs.colour) AS colour, jobs.status, jobs.attempt_count
        FROM story_video_jobs AS jobs JOIN products ON products.id = jobs.product_id
          AND products.status = 'active' AND COALESCE(products.video_design_revision_id, products.design_revision_id) = jobs.design_revision_id
        WHERE jobs.design_revision_id = ? AND jobs.renderer_version = ? LIMIT 4
      `).bind(revision, STORY_VIDEO_RENDERER_VERSION).all<StatusRow>();
      return result.results;
    });
    if (request.method === "GET" && url.pathname === "/events") return this.hub.subscribe(request);
    if (request.method === "POST" && url.pathname === "/notify") return this.hub.notify().then(() => new Response(null, { status: 204 }));
    return new Response(null, { status: 404 });
  }
}

export async function notifyStoryVideoReady(env: StoryVideoNotificationEnv, revisionId: string) {
  if (env.STORY_VIDEO_NOTIFICATION_MODE !== "push" || !env.STORY_VIDEO_NOTIFICATIONS) return false;
  try {
    const response = await env.STORY_VIDEO_NOTIFICATIONS.getByName(revisionId).fetch(new Request(
      `https://story-video-notifications.internal/notify?revision=${revisionId}`,
      { method: "POST", signal: AbortSignal.timeout(3_000) },
    ));
    if (!response.ok) throw new Error(`Notification failed: ${String(response.status)}`);
    await response.arrayBuffer();
    return true;
  } catch {
    console.warn("Story video notification unavailable; snapshot recovery remains active.");
    return false;
  }
}
