import { prepareStoredArtwork, validateSourceImage } from "../../workers/api/src/image-processing";

// Diagnostic only. The generated dev config has one remote Images binding and
// accepts only the generated fixture hashes. No application routes import this.
interface ProbeEnv {
  IMAGES: ImagesBinding;
  SOURCE_SHA256: string;
}

function stream(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

function base64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

async function readSource(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 20_000_000) { await reader.cancel(); return undefined; }
    chunks.push(value);
  }
  const source = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { source.set(chunk, offset); offset += chunk.length; }
  return source;
}

export default {
  async fetch(request: Request, env: ProbeEnv) {
    const url = new URL(request.url);
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) return new Response("Local probe only", { status: 403 });
    if (request.method === "GET" && url.pathname === "/health") return new Response("artwork-preview-benchmark-v1");
    if (request.method !== "POST" || !["/baseline", "/two-track"].includes(url.pathname)) {
      return new Response("Not found", { status: 404 });
    }
    const edge = Number(url.searchParams.get("edge") ?? 1024);
    if (![768, 1024, 1600].includes(edge)) return new Response("Invalid preview edge", { status: 400 });
    const source = await readSource(request);
    if (!source?.length) return new Response("Invalid source size", { status: 413 });
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(source)));
    const hash = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
    if (!env.SOURCE_SHA256.split(",").includes(hash)) return new Response("Unrecognised fixture", { status: 403 });
    const started = performance.now();
    const validation = await validateSourceImage(env.IMAGES, source);
    if (!validation.ok) return Response.json(validation, { status: 422 });
    const encoder = new TextEncoder();
    let disconnected = false;
    const output = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (name: string, data: object = {}) => {
          if (!disconnected) controller.enqueue(encoder.encode(JSON.stringify({ name,
            elapsedMs: Math.round(performance.now() - started), ...data }) + "\n"));
        };
        const image = (name: string, bytes: Uint8Array) => emit(name, { bytes: bytes.length, base64: base64(bytes) });
        const preview = async () => {
          // Materialize a resized, white-backed input so segmentation really
          // receives the small image. Never reuse this input for print.
          const resized = await env.IMAGES.input(stream(source))
            .transform({ background: "white", fit: "scale-down", width: edge, height: edge })
            .output({ format: "image/png", anim: false });
          const response = resized.response();
          if (!response.ok) throw new Error("Preview input failed");
          const small = new Uint8Array(await response.arrayBuffer());
          emit("preview-input", { bytes: small.length });
          const result = await env.IMAGES.input(stream(small)).transform({ segment: "foreground" })
            .output({ format: "image/webp", quality: 90, anim: false });
          const cutout = result.response();
          if (!cutout.ok) throw new Error("Preview segmentation failed");
          const bytes = new Uint8Array(await cutout.arrayBuffer());
          if (bytes.length > 1_024 * 1_024) throw new Error("Preview too large");
          image("early-preview", bytes);
        };
        const full = async () => {
          // The exact production preparation functions, with the same sequential
          // full-resolution work, encoding retries and dimension validation.
          const original = await prepareStoredArtwork(env.IMAGES, source, false, validation.image);
          if (!original.ok) throw new Error("Original preparation failed");
          emit("original-ready", { bytes: original.bytes.length, width: original.width, height: original.height });
          const cutout = await prepareStoredArtwork(env.IMAGES, original.bytes, true, original);
          if (!cutout.ok) throw new Error("Print preparation failed");
          image("print-ready", cutout.bytes);
          const display = await env.IMAGES.input(stream(cutout.bytes))
            .transform({ width: 1600, height: 1600, fit: "scale-down" })
            .output({ format: "image/webp", quality: 90 });
          const response = display.response();
          if (!response.ok) throw new Error("Final preview failed");
          image("final-preview", new Uint8Array(await response.arrayBuffer()));
        };
        // This open response is a measurement transport, not a durable job.
        // A production implementation must persist screened source + a fenced
        // job before returning an early preview and let a queue own completion.
        const tasks = url.pathname === "/baseline" ? [full()] : [preview(), full()];
        void Promise.allSettled(tasks).then(results => {
          for (let index = 0; index < results.length; index++) {
            if (results[index]?.status === "rejected") emit("error", { branch: tasks.length === 2 && index === 0 ? "preview" : "print" });
          }
          emit("complete");
          if (!disconnected) controller.close();
        });
      },
      cancel() { disconnected = true; },
    });
    return new Response(output, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
  },
};
