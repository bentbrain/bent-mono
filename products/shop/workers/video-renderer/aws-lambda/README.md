# Isolated Lambda video benchmark

This adapter reuses the approved scene and renderer for both shirts and both
totes. One invocation renders one product and returns only after a checksummed
MP4 has been committed to private S3. Four products can dispatch independently;
the benchmark compares one customer (four invocations) with two customers
(eight invocations).

Status on 2026-08-28: the current private image passed native imports, 17
in-image tests and the actual bootstrap/RIC smoke check. After an earlier cohort
exposed S3 TLS failures, the corrected connection handling completed 24 real
saved-design renders with full four/eight-handler overlap and verified downloads.
The account concurrency limit is now 1,000 and its request is closed, but the
verified memory cap remains 3,008 MB. The function has eight reserved slots at
3,008 MB. These small cohorts do not qualify large-scale performance or cold-start
latency. Production is unchanged. See [the results](../../../docs/spikes/aws-lambda-video-benchmark-2026-08-28.md)
and [the setup record](../../../docs/aws-personal-setup.md).

## Account boundary and cost limits

Read [the personal-account rules](../../../docs/aws-personal-setup.md) first.
Every local AWS operation must use `node scripts/aws-personal.mjs`. Do not call
an AWS CLI/SDK with default credentials, read other profiles, or use a work
account. Authentication failure is a stop, not permission to try another identity.

Resources are fixed to account `{{SHOP:awsAccountId}}`, Sydney `ap-southeast-2`, name
`forever-tee-video-bench`. The template provides:

- Private, encrypted, versioned S3 and immutable-tag ECR; neither has public access.
- A CodeBuild project, limited to one concurrent small build and 20 minutes.
- A digest-pinned x86 Lambda, 120-second timeout and eight reserved executions
  by default. Explicit sequential-smoke mode omits the reservation.
- Separate build/render roles scoped to the benchmark's resource prefixes.
- Seven-day logs and output expiry. Inputs, source bundles and ECR images remain
  until deliberately cleaned up; deleting the stack retains the bucket/repository.
- No function URL, public invoke policy, event source, scheduled warming, paid
  provisioned concurrency or changes to existing functions.

Eight reserved executions cap concurrency and reserve capacity. Processes start
on demand. AWS requires 100 unreserved units. The account initially had only 10,
so a separate sequential smoke mode was added. The applied quota is now 1,000,
with eight reserved for this benchmark. The concurrent driver requires at least
108 account capacity and its exact eight-slot reservation.

Local unit tests use simulated rendering and AWS calls. Run builds and rendering
in the cloud to keep that work off the owner's Mac. Cloud scripts require their
scoped execution roles; local AWS access must use the guarded personal runner.

## Local checks

From the repository root:

```sh
nice -n 15 node --test --test-concurrency=1 workers/video-renderer/aws-lambda/*.test.mjs scripts/aws-personal.test.mjs
bash -n workers/video-renderer/aws-lambda/cloud-build.sh
node --check workers/video-renderer/aws-lambda/runtime-smoke.mjs
```

The tests cover all four products, exact approved motion, input checksums,
storage acknowledgement, failed/cancelled reads, output isolation, independent
dispatch, capacity guards, private infrastructure, and source-bundle contents.
The two-customer unit test checks dispatch logic with simulated invocations.
Measure speed and AWS scaling with the cloud benchmark.

## Cloud build, independent of the quota request

These steps create billable resources and scoped IAM roles. Review the template
and obtain authorization before creating/executing a change set or starting a
build. No local Docker build is needed.

1. Package a new source bundle. The destination must be new; existing bundles
   are never overwritten. Only allowlisted renderer, runtime, dependency and
   test files are included. Customer images, `.env`, `.data` and credentials
   cannot enter the bundle through directory expansion.

   ```sh
   node workers/video-renderer/aws-lambda/package-source.mjs .data/aws-lambda/build-20260828
   ```

   Record the returned `sourceDigest`, `zip`, `template` and `sourceKey`. In the
   commands below replace `SOURCE_DIGEST` and the absolute paths with those
   exact values; placeholders are not runnable configuration.

2. Validate, then create a **CREATE change set** for the fixed benchmark stack,
   leaving `ImageDigest` empty. This creates S3/ECR/CodeBuild, but no Lambda or
   reserved capacity. Inspect the change set before executing it.

   ```sh
   node scripts/aws-personal.mjs cloudformation validate-template --template-body file:///ABSOLUTE/PATH/cloudformation.json
   node scripts/aws-personal.mjs cloudformation create-change-set --stack-name forever-tee-video-bench --change-set-name foundation --change-set-type CREATE --template-body file:///ABSOLUTE/PATH/cloudformation.json --parameters ParameterKey=SourceDigest,ParameterValue=SOURCE_DIGEST --capabilities CAPABILITY_NAMED_IAM
   node scripts/aws-personal.mjs cloudformation describe-change-set --stack-name forever-tee-video-bench --change-set-name foundation
   node scripts/aws-personal.mjs cloudformation execute-change-set --stack-name forever-tee-video-bench --change-set-name foundation
   node scripts/aws-personal.mjs cloudformation describe-stacks --stack-name forever-tee-video-bench
   ```

   If the stack already exists, inspect it first and use a reviewed UPDATE change
   set. Do not recreate or overwrite unrelated resources. Wait for stack completion
   before the next step; inspect stack events on failure, without automatic retries.

3. Verify bucket ownership, upload the exact bundle and start the cloud build.

   ```sh
   node scripts/aws-personal.mjs s3api head-bucket --bucket forever-tee-video-bench-{{SHOP:awsAccountId}}-ap-southeast-2 --expected-bucket-owner {{SHOP:awsAccountId}}
   node scripts/aws-personal.mjs s3 cp /ABSOLUTE/PATH/SOURCE_DIGEST.zip s3://forever-tee-video-bench-{{SHOP:awsAccountId}}-ap-southeast-2/source/SOURCE_DIGEST.zip --only-show-errors
   node scripts/aws-personal.mjs codebuild start-build --project-name forever-tee-video-bench
   node scripts/aws-personal.mjs codebuild batch-get-builds --ids RETURNED_BUILD_ID
   node scripts/aws-personal.mjs ecr describe-images --repository-name forever-tee-video-bench --image-ids imageTag=source-SOURCE_DIGEST
   ```

   The build verifies the manifest, installs locked packages, compiles the official
   AWS Runtime Interface Client, and tests native module imports. Its network-isolated
   smoke test boots the image's actual bootstrap and RIC against a fake Runtime API and verifies that the
   real handler rejects invalid input. This catches entrypoint/runtime problems
   without rendering or accessing S3. Only a passing image is pushed.

   RIC 4 requires `_HANDLER` and `LAMBDA_TASK_ROOT` in the environment. The fixed
   bootstrap supplies these from the image's approved handler, rather than relying
   on the older positional-argument behavior. The smoke test includes Lambda's
   required version/log context fields as well as fake execution credentials.

   Record the successful build ID, image digest and FFmpeg version from the log.
   The code digest is not an image digest: apt/base-image changes can affect image
   bytes. The immutable ECR tag deliberately prevents silently replacing a build.

## Deploy the isolated function after capacity is available

Recheck the quota and existing reservations through the guarded runner. Do not
alter other functions. A quota approval message alone does not establish that
the new quota is applied.

Create and inspect an UPDATE change set for `forever-tee-video-bench` using the
same template. Supply all three parameters:

- `SourceDigest`: the manifest digest used for that successful image build.
- `ImageDigest`: the exact `sha256:...` ECR image digest, not a tag.
- `MemoryMB`: currently `3008`. AWS rejected `8192` both before and after the
  concurrency increase. The planned `8192` comparison needs the separate memory
  restriction lifted. Do not infer availability from the MicroVM memory quota.

Use `--capabilities CAPABILITY_NAMED_IAM`. The new function has no public endpoint.
Wait for the stack and function update to finish. The live benchmark independently
checks the account limit, reserved eight slots, function ARN, image digest, build
ID, memory, active state and successful update before invoking anything.

### Sequential smoke checks before quota approval

For sequential testing within the available quota, explicitly deploy `CapacityMode=sequential-smoke` with
the verified image/build digest and memory setting. This omits the reservation,
using the shared unreserved pool. It does not change any existing function.
The default remains `reserved-eight`; the concurrent runner will still refuse
to run against the unreserved smoke configuration.

```sh
node workers/video-renderer/aws-lambda/sequential-smoke.mjs /ABSOLUTE/PATH/fixture.json
```

This makes four synchronous invocations, one at a time, and stops at the first
failure. No retries, event sources or public endpoint are added. The driver
checks function identity/mode, unreserved capacity and recent account concurrency
metrics. It refuses known insufficient headroom. Missing or delayed CloudWatch
metrics do not prove zero activity, so results explicitly carry that limitation.
A local lock prevents two copies of this driver running on this Mac; it is not
a global semaphore. Never manually run another invocation alongside it. A crashed
driver's lock must be inspected, not automatically removed.

The report can qualify only as `completed-smoke-only`. It cannot qualify customer
isolation, concurrent first/all-four readiness, or sustained scale. Once the quota
is available, use a reviewed change set to restore `reserved-eight` before the
four-versus-eight benchmark. A low-memory account limit is separate from the
concurrency limit; label any lower-memory trial accordingly.

## Prepare the real saved design

`saved-design.example.json` records the previously used saved design ID and
product-specific geometry. Its artwork path is a placeholder. Confirm the saved
revision and settings, and retrieve its actual background-removed PNG before
running. On 2026-08-28 the original revision was read from development D1 and
its PNG recovered from R2, with matching checksum
`{{SHOP:resource_73e91e639e8e}}`.
Use that original background-removed artwork for the comparison.

Create a private JSON file matching the example, with the exact local artwork
path. Preparation copies and hashes the artwork plus the four approved cutouts
from `apps/web/public/mockups`; it does not render or upload them.

```sh
node workers/video-renderer/aws-lambda/prepare-fixture.mjs prepare /ABSOLUTE/PATH/saved-design.json .data/aws-lambda/saved-design
node workers/video-renderer/aws-lambda/prepare-fixture.mjs upload /ABSOLUTE/PATH/saved-design/fixture.json
```

Uploading is a separate explicit action. All assets/settings are validated before
any AWS request, bucket ownership is checked, and uploads are verified. Lambda
reads exact content-addressed keys and verifies full SHA-256 hashes again. No
arbitrary asset URLs, bucket names or output keys are accepted in jobs.

## Run a bounded benchmark

```sh
node workers/video-renderer/aws-lambda/benchmark.mjs /ABSOLUTE/PATH/fixture.json 1
```

Start with one round: four renders, then eight simultaneous renders. The runner
supports 1–5 rounds (12–60 videos total), alternating cohort order and rotating
variant order. It invokes all jobs independently, reports each completion as it
arrives, retains failures, and stops further rounds after an invocation or stored
video verification failure. CLI invocation and S3 write retries are disabled.
Idempotent S3 asset reads allow up to three SDK attempts within a shared
20-second deadline, and report actual attempts/retry delay. Writes create a
fresh client connection, then destroy it after acknowledgement or failure, so
a frozen runtime cannot reuse an idle write socket.

Results and downloaded MP4s go into a new ignored `.data/aws-lambda/benchmark-*`
directory. Downloads happen **after** readiness timing stops and are checksum-
verified. Review the downloaded videos separately from this command. Each attempt
has a new output namespace; duplicate writes fail rather than overwriting a video.

Read the evidence as follows:

| Measurement | Meaning |
| --- | --- |
| `renderMs`, canvas/encoder times | Existing renderer's measurements, excluding S3. Some phases overlap; don't sum them blindly. |
| `assetReadMs`, `storageWriteMs` | Input S3 reads/hash checks and committed output S3 write. |
| `runtimeLoadMs`, `handlerMs` | Lazy imports and full handler execution, respectively. |
| AWS `Init Duration`, `Duration`, `Billed Duration` | Platform cold-init, execution and billing evidence for that request. Preserve missing values rather than inventing zero. |
| `firstInvocationInProcess` | First invocation in this runtime, **not** proof of a cold start. |
| Per-customer first/all-four ready | Time from batch dispatch to storage-acknowledged responses received by the local driver. Includes CLI startup, guarded STS checks and network. |
| `peakConcurrentHandlers`, `fullOverlapObserved` | Whether all four/eight handler intervals actually overlapped. Cross-runtime wall-clock skew limits precision. |

An incomplete platform report produces a nonzero exit and
`incomplete-platform-evidence`; a failure cannot qualify as all-four-ready.
If any cohort lacks full handler overlap, the final status is
`incomplete-overlap-evidence` with a nonzero exit, not a scaling success.
Small cohorts are exploratory evidence, not meaningful p95/p99 estimates. A
`completed` report means this run's checks passed, not approval for production.

## Gates before production integration

1. Real cloud image build and runtime/S3 render success. Review all four downloaded
   videos against the approved reference: focal point, garment cutouts (especially
   white), geometry, blue, text/cursor, easing, duration and end frame. Measure
   frame differences in the cloud if useful. Runtime/FFmpeg differences mean
   byte-identical or visually identical output must not be assumed.
2. Separate actual cold-init samples from warm samples using AWS REPORT evidence.
   Repeat one- versus two-customer runs with genuine overlap, compare each product
   and first/all-four readiness, and try memory settings with the same image and
   inputs. Compute billed GB-seconds from memory and billed duration before
   applying current regional prices; include builds, storage, transfer and logs.
3. Run deadline, storage failure and retry/deduplication checks. A stored output
   alone must not publish an incorrect product video. Verify resource limits and
   sustained/burst behaviour at a separately approved load/cost cap.
4. Integrate dispatch, immutable production keys, R2 delivery and per-video
   availability notifications behind a reversible provider switch, retaining the
   current Cloudflare path for rollback. Existing storefront orchestration uses
   Effect. Preserve that orchestration when integrating this isolated Node adapter.
5. Measure the actual save-design → first playable/all-four playable path on
   mobile. **Private S3 benchmark timing is not production R2/CDN/browser timing.**

Lambda gives each concurrent invocation separate compute. Measure latency at the
expected demand. Account/function quotas, burst ramp-up, cold
starts, downstream storage and dispatch limits still apply. Eight simultaneous
invocations test isolation at that cohort size. Agree a measurable latency target,
then provision and load-test the expected demand before setting production capacity.

References: [Lambda container images](https://docs.aws.amazon.com/lambda/latest/dg/nodejs-image.html),
[AWS Node Runtime Interface Client](https://github.com/aws/aws-lambda-nodejs-runtime-interface-client),
[reserved concurrency](https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html),
[S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html).
