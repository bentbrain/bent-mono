# Isolated print Lambda benchmark

This manual Development experiment compares the current Cloudflare print outputs with a private Node.js 24 Lambda using Sharp 0.35.4. It does not change the storefront, queue, print provider, production functions or checkout readiness.

The workflow accepts only an exact reviewed main commit, first attempt, protected Preview identity and the personal Sydney account. Its separate CI role can create and remove only `forever-tee-print-benchmark-development`. The runtime role can read/write only `source/print-benchmark/*` in the existing private Development bucket and write its own logs. Both roles have matching permission boundaries. No public function URL, event source, scheduled invocation or provisioned concurrency is created.

The owner approved the one-time four-resource IAM bootstrap in `infra/print-benchmark/access.json`, SHA-256 `638cf79627a643d38d6bdf717136bc0861c0b8da5e8688231f23fe30d9a3b009`, on 2026-09-18 AEST. Its CREATE change set must contain only the two new roles and two boundaries. This does not authorize replaying a bootstrap or changing existing IAM policies. Function packaging, deployment, invocation and removal remain in GitHub Actions.

Each invocation renders the three shirt print geometries at 3008 MB. The function has a 60-second timeout and a reservation of two concurrent executions. Ten invocations cover the same camera/cropped sources and settings used for Cloudflare validation, including two simultaneous invocations. Geometry plans come from the application's existing crop/recursion functions. Images are read once per invocation, verified by size/SHA-256, rendered with lossless PNG output and committed to new versioned S3 keys. Storage writes and invocations have no automatic retry.

The report includes driver end-to-end time, source read, render/write timing, AWS REPORT cold initialization and memory, and per-channel/alpha differences against the exact Cloudflare PNGs. Reference PNGs are preserved in the private benchmark S3 prefix and pinned by object version and SHA-256, independently of application fixture cleanup. Missing platform evidence fails the run. A first handler invocation alone does not establish a cold start. This experiment excludes the application queue, R2 publication and browser readiness. It does not establish print-quality acceptance or sustained traffic capacity.

The temporary function is deleted only after checking its exact ARN and run/source tags. Unknown creation acknowledgements stop for inspection. Private checksummed inputs and outputs remain under the run prefix for quality review, with their exact version inventory retained. Portrait bytes and credentials are not published in Actions artifacts. A failed cleanup requires inspection before another run.

```sh
node --test scripts/print-benchmark.test.mjs
node workers/print-benchmark/prepare-plans.mjs
npm ci --prefix workers/print-benchmark/runtime
node --test workers/print-benchmark/runtime/*.test.mjs
```

Native dependencies are installed on the Linux Actions runner for Lambda's x86_64 architecture. References: [AWS Node.js ZIP packages](https://docs.aws.amazon.com/lambda/latest/dg/nodejs-package.html), [Sharp native installation](https://sharp.pixelplumbing.com/install/).

## Native renderer follow-up

The candidate renderer decodes prepared, unprofiled 8-bit sRGB PNG artwork once per print geometry and reuses its pixels across recursive layers. Those layers use raw pixel buffers, so only the final print is PNG encoded. Other formats retain the original decoding and intermediate PNG path. Resize, trim, composition order, straight-alpha handling and final PNG encoding remain unchanged. The handler interface is still `renderPrint(source, plan)` and still runs three geometries together. No workflow, IAM or active provider change is needed to package this renderer in the existing isolated benchmark.

`runtime/testing/png-layer-reference.mjs` freezes the previous native renderer. Tests compare every output RGBA byte against it for overlapping cropped layers, source channels 1–4, JPEG, profiled PNG and 16-bit PNG. The local benchmark also compares all six existing camera/cropped fixture prints at full resolution before measuring four alternating samples per implementation, with the same three-geometries-at-once execution used by the Lambda handler.

```sh
node workers/print-benchmark/prepare-plans.mjs
node workers/print-benchmark/runtime/benchmark-render.mjs \
  PATH_TO_CAMERA_SOURCE.png PATH_TO_CROPPED_SOURCE.png PATH_TO_REPORT.json
```

Source files must match the exact fixture length and SHA-256. The local command does no network work and writes only numeric results, source hashes and runtime metadata. It does not require AWS credentials. These measurements exclude source retrieval, queueing, output storage, tote generation and browser readiness. Raw pixels use more memory than compressed intermediate layers, so a subsequent cloud run must inspect peak memory as well as duration. Matching the previous native renderer does not establish pixel equivalence with Cloudflare or print-quality acceptance.

Sharp documents raw overlay dimensions and alpha handling in its [compositing API](https://sharp.pixelplumbing.com/api-composite/) and [raw input options](https://sharp.pixelplumbing.com/api-constructor/).

## Scope of the next AWS comparison

The existing benchmark identities can create, directly invoke, set reserved concurrency for and remove only the exact temporary print function. They can access only private objects under the benchmark S3 prefix and the function's logs. The consumed IAM bootstrap cannot be replayed to extend that scope.

Without expanding IAM, a reviewed bounded Actions revision can test the improved renderer, both product families, larger but explicitly capped invocation cohorts, and Lambda asynchronous invocation with a private S3 completion manifest. Asynchronous testing first needs idempotent publication and recovery after partial writes. The current handler returns results synchronously and treats an existing output as a conflict, so changing `InvocationType` alone is not a durable architecture. Any reserved-concurrency increase must be explicit in the experiment contract and reported with its invocation count and cleanup evidence.

A real application candidate needs a separately reviewed Development integration. Keep the application's immutable revision, job lease and completion fencing authoritative. Dispatch an exact job identity plus pinned source and geometry manifest, acknowledge only durable acceptance, and publish completion only after every required object is present with verified dimensions, byte count and checksum. Duplicate execution must return the same committed result; partial execution must recover without replacing another attempt's output. A completion callback needs authentication and lease fencing, and a stalled callback needs reconciliation from the durable result.

For an SQS-to-Lambda candidate this requires a separate queue and dead-letter queue, event-source mapping, narrowly scoped runtime receive/delete/visibility permissions, and an application sender identity. Those resources and permissions are absent from the benchmark boundary. A Lambda asynchronous-invocation candidate needs a dedicated application invoke identity and reviewed retry/failure-destination controls; the existing video invoker cannot invoke the print function. R2 publication additionally needs narrowly scoped Development upload access or signed, expiring upload grants and an authenticated completion route. Keep customer artwork private and never transfer personal SSO credentials to a worker.

An Actions driver can bridge isolated S3 outputs back to a temporary R2 prefix without creating an application invoke identity, if that new path is reviewed and guarded. Such a bridge measures transfer and integrity checks, but its scheduling is not an application dispatch path. It must not be presented as checkout-readiness or sustained-capacity qualification. The final provider comparison must run through the real durable dispatch, required shirt and tote geometry completion, R2 publication and application readiness path, including quiet starts, bursts, sustained traffic and retry/failure cases.
