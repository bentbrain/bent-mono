# Isolated renderer comparison

Run these experiments on the benchmark Worker, using its separate Durable Object
namespace, one `standard-3` instance, and unique keys under `benchmarks/` in the
development R2 bucket. Keep production Workers, product jobs and existing videos
unchanged. Every completed or failed batch destroys its container.
Cache reads do not wake it.

## Build without local Docker

The manually dispatched `story-renderer-benchmark.yml` workflow builds on GitHub's runner
and pushes to the existing Cloudflare registry. It needs temporary
`STORY_BENCHMARK_REGISTRY_USERNAME` and `STORY_BENCHMARK_REGISTRY_PASSWORD` secrets
from `wrangler containers registries credentials --push --pull --json`.
Keep credentials out of logs and remove those GitHub secrets after the build.

Both images inherit the exact deployed image digest. The old-Canvas image keeps
its existing dependencies. The candidate installs only Canvas 1.0.8 and its
native dependencies in a separate directory, preserving Node, FFmpeg and fonts.
No customer artwork is included in the source or container images.

## Run

Use `wrangler.jsonc` for the old Canvas and `wrangler-canvas-new.jsonc` for the
new Canvas. They deliberately use separate Worker/Container namespaces. Updating
an existing application's image can leave an older process serving initial
requests during rollout, even after `wrangler deploy` returns.

Select the built image in the corresponding config, then deploy only that configuration:

```sh
bun run --dir workers/video-renderer exec wrangler deploy --config benchmarks/wrangler.jsonc --keep-vars
```

Set `BENCHMARK_TOKEN` on that Worker and supply the same value privately as
`REMOTE_BENCHMARK_TOKEN` to the driver. Run the driver with:

- `REMOTE_BENCHMARK_URL`: the isolated benchmark Worker URL
- `STORY_ARTWORK`: path to the saved design's background-removed PNG
- `STORY_BENCHMARK_OUTPUT`: private output directory
- `STORY_BENCHMARK_LABEL`: unique lowercase experiment label
- `STORY_BENCHMARK_ROUNDS`: one to ten fresh-process batches, default three
- `STORY_SCALE_BEFORE_HOLD=1`: opt into the filter-order experiment

```sh
node workers/video-renderer/benchmarks/compare-remote.mjs
node workers/video-renderer/benchmarks/summarize.mjs /private/results/*.json
```

The fixture uses the saved design's real crop and separate shirt/tote placement.
It renders all four variants sequentially, rotates the first product between
rounds, verifies fresh process IDs and request sequences, checks container
shutdown, and downloads the R2 results. Do not probe the renderer while a batch
is running. A diagnostic render changes its request sequence and invalidates
that sample.

Compare the four combinations of Canvas version and filter order. The option
defaults off in the renderer. The v6 production job explicitly opts in. Turning
it off restores the original FFmpeg filter graph, but does not revert v6 copy.
Native 1080p input skips this experiment because there is no upscale to move.

The recorded 27 August comparison used commit `cf1c847`. Check out that revision
to reproduce its original scene and exact hashes. Later releases change copy
and renderer identity, so their output cannot be compared as an unchanged control.

## Visual gate

`inspect.mjs` downloads only existing R2 cache hits. Run it on a cloud runner with
FFmpeg and `REMOTE_BENCHMARK_TOKEN`, passing an input JSON file and output folder.
The input contains `endpoint`, `videos: [{ name, key }]`, and
`comparisons: [{ reference, candidate }]`.

It checks 240 frames, eight seconds, 1080 by 1920, H.264, yuv420p and 30 fps.
It records full-video SSIM, minimum per-frame SSIM, and zoom-only SSIM. The
automated gate requires mean SSIM at least 0.995 and no frame below 0.96, followed
by manual inspection of timeline sheets and full-resolution cursor-on/off frames.
Use SSIM to detect rendering drift, then complete the required visual review.

The inspection workflow retains private artifacts for seven days. Remove its
temporary `STORY_BENCHMARK_TOKEN` GitHub secret after inspection.

## Measurement limits

The first render in each batch includes fresh-process library work. Batch Worker
time also includes container startup, input processing, R2 writes and shutdown.
Client time includes upload and network delay and must not be described as pure
cold-start time. Three rounds provide a directional comparison, not a p95 SLA.
Record failed requests and excluded samples separately from successful timings.
