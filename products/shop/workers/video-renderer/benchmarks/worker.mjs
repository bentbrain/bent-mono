import worker from "../src/worker.mjs";
export { StoryVideoContainer } from "../src/worker.mjs";

export default {
  async fetch(request, env) {
    const startedAt = Date.now();
    const response = await worker.fetch(request, env);
    if (new URL(request.url).pathname !== "/render-batch" || !response.ok) return response;
    const body = await response.json();
    return Response.json({ ...body, workerTimeMs: Date.now() - startedAt });
  },
};
