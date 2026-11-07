# Story video renderer

For the manual 4K featured-cutout export, see
[Custom featured video export](../../docs/custom-featured-video.md).

This Cloudflare Container workload reproduces the
browser composition with a server-side Canvas, pipes 91 unique RGBA frames into
FFmpeg, holds the final frame for five seconds, and returns a fast-start H.264
MP4. The Worker stores the result in a dedicated private R2 bucket. The API
Worker owns idempotent job state in D1 and sends revision batches through a
Cloudflare Queue. `StoryVideoService` is the private service entrypoint used by
that orchestrator for batch renders and stored-video reads.

## Pipeline transport experiments

The API's `STORY_VIDEO_TRANSPORT=direct` flag sends an immutable artwork
reference instead of a multi-megabyte data URL. The container fetches artwork
and the fixed garment through `story-storage.internal`, verifies the artwork
size and SHA-256, runs the unchanged encoder, and uploads the exact MP4 through
the same private outbound Worker handler. That handler streams into R2 with an
enforced content length. Only a successful R2 acknowledgement makes the job
ready. General Internet access remains disabled; no Cloudflare credentials
are placed in the container. Artwork is not baked into its image.

The flag is initially enabled only in development. Omit it or set it to
`baseline` to restore the original base64-input/MP4-response transport. The
existing D1 jobs and immutable media keys are unchanged, so rollback does not
require a migration or invalidate already-stored videos. A retry checks R2
before rendering again, including after a lost storage acknowledgement.

`STORY_VIDEO_WARM_ON_CONFIRM=1` is a separate API flag enabled in development. It warms
only after a successful configured-product request, without blocking its
response, so startup can overlap job preparation and dispatch. It does not
change the 30-second idle timeout or the two-container capacity limit. The
existing post-image-processing warmup is unaffected when this flag is absent.

Use the `profile` input of the deployed latency workflow for stage timings and
`cold` to require stopped containers before a development family. Compare
first/all-four readiness, output hashes and renderer time. See
`docs/spikes/story-video-pipeline-latency-2026-08-28.md` for timing details.

Cloudflare Workers Containers require the Workers Paid plan. Local rendering
and Docker benchmarking do not require the account upgrade.

`Dockerfile.vercel` deploys the same renderer as an isolated Vercel Function in
Sydney with Fluid compute. Set `BENCHMARK_TOKEN` on the Vercel project, then run
`VERCEL_BENCHMARK_URL=https://... VERCEL_BENCHMARK_TOKEN=... bun run benchmark:remote`
to measure warm sequential and four-way concurrent renders using the saved
design and all four product mockups. The remote endpoint rejects renders unless
the bearer token matches. Set `STORY_BENCHMARK_SCENARIO=single` to benchmark
only the white tee, and set `STORY_FFMPEG_PRESET=veryfast` (or another FFmpeg
preset) to compare encoding speed and output size without redeploying.

For Cloudflare, set `REMOTE_BENCHMARK_URL`, `REMOTE_BENCHMARK_TOKEN`, and
`STORY_BENCHMARK_R2=1`. The first request renders and stores a unique object;
the reported `cache` request downloads the same MP4 from R2 without waking the
Container. Set `STORY_BENCHMARK_REPORT=/tmp/report.json` to preserve the full
result outside the terminal.

`wrangler dev` runs the Worker, local R2 cache, Durable Object, and Container
together. Send a deterministic `x-story-video-key` with `POST /render`; the
first request renders and stores the MP4, while later requests return the R2
object without waking the renderer.
