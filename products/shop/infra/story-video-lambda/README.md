# App video rendering on Lambda

Continuation status: this module now uses the verified KMS-encrypted, versioned
S3 backend with native locking. The original local state and backup remain
unchanged and private. The guarded runner no longer permits historical local
application `terraform apply`; deployment must use the paired Actions pipeline.
`ci_execution=true` selects the verified temporary CI credentials without reading
shared profiles; local execution defaults to the exact personal SSO profile.
Neither mode changes the explicit account/region guard. The dedicated native
Development workflow now builds and verifies immutable candidates and performs
paired release/rollback, startup checks and cloud qualification. The repaired
pair passed the initial eight-video and exhaustion tests. Remaining fault/load,
mobile and Production gates are recorded in
[runtime recovery](../../docs/native-lambda-runtime-recovery-2026-08-29.md).

For dependency checksum maintenance only,
`node scripts/aws-personal.mjs terraform lock-provider` fetches the fixed
Darwin ARM64/Linux AMD64 AWS-provider packages, verifies their publisher
signatures and retains a private copy of the original lockfile. It cannot
change platforms, versions, backend configuration or resources. Review and
commit the resulting checksum diff; CI initialization remains read-only.

Development uses one asynchronous Lambda invocation per video, with four independent
invocations per design. Cloudflare Queue recovery, D1 state, R2 media URLs and
the existing gallery remain in place. The browser never encodes video.

The production Worker remains on Cloudflare. Do not point it at this development
function or its development-only asset transfer endpoint.

## Account and credentials

Only personal account `{{SHOP:awsAccountId}}`, Sydney, is allowed. All Terraform commands
run through `node scripts/aws-personal.mjs terraform ...` from the repository root.
That wrapper validates the project SSO configuration, verifies the personal
identity, removes inherited AWS and Terraform settings, and pins the module path.
The provider also restricts the account and profile. Never run authenticated
Terraform directly or configure global AWS credentials for this project.

The renderer role has log permissions and permission to send failures to one SQS
queue. It receives a three-minute
HMAC grant for one claimed D1 job and attempt. It reads that job's artwork and
uploads its MP4 through the development API. Requests cannot choose asset URLs.
Four product cutouts are baked into the image.

The Worker has a dedicated IAM service key with only `lambda:InvokeFunction` for
this exact function. It has no console, S3, IAM or other Lambda permissions.
`configure-app-secrets.mjs` stores it in Cloudflare secrets without logging values.
It keeps a recovery file under `.data/aws-personal/`, mode 0600. This is a service
credential, never an exported personal SSO credential. Rotate it before a shared
production rollout, and use a separately scoped identity there.

Original Terraform state snapshots and private plans remain under
`.data/terraform-story-video/`, mode 0700 for the directory. Active state is
remote with KMS encryption, versioning and S3 locking. Access keys are not in
Terraform state. Retained local snapshots must not be applied or overwritten.

## Current release stop

The commands below record the earlier Development bootstrap. They are not a safe
release sequence for the current execution-claim protocol and migration 0018.
The normal release workflow intentionally refuses native API/renderer releases.
Do not bypass it with a manifest, readiness flag, or an ad hoc Worker deployment.
See [the current rollout gate](../../docs/native-lambda-review-fixes-2026-08-28.md)
and [the release audit](../../docs/native-lambda-release-audit-2026-08-28.md).

The dedicated native Development release path pauses admissions and verifies
the pause, then drains or reconciles existing attempts. It applies migration
0018 and deploys the compatible Worker plus both native handlers while paused.
It verifies live image digests, source provenance, startup and protocol before
resuming. An interrupted deployment must leave admissions paused for recovery.
Production does not yet have this completed path.

The commented `remote-state.example.hcl` does not configure or provision remote
state. The guarded Terraform wrapper and service-key exception remain limited
to Development. New state infrastructure and CI access require owner approval.

## Historical Development bootstrap

First provision the build foundation:

```sh
node scripts/aws-personal.mjs terraform init
node scripts/aws-personal.mjs terraform validate
node scripts/aws-personal.mjs terraform plan
node scripts/aws-personal.mjs terraform apply
```

Review the plan before applying. It creates only development resources and does
not import or modify the separate benchmark CloudFormation stack.

Package an allowlisted source bundle, including the four checked-in cutouts:

```sh
node workers/video-renderer/aws-lambda/package-app-source.mjs .data/aws-lambda/app-release
```

Upload the returned ZIP to the returned `sourceKey` in
`forever-tee-video-development-{{SHOP:awsAccountId}}-ap-southeast-2`, using the guarded
runner's `s3 cp`. Start CodeBuild project `forever-tee-video-development` with
that S3 source location and plaintext `SOURCE_DIGEST` equal to the returned
manifest hash. CodeBuild verifies every file, builds Linux x86, runs contract and
real-runtime boot tests, then pushes an immutable `source-<hash>` ECR tag.
There is no local Docker build or local video encoding.

After CodeBuild succeeds, read the image digest using the guarded runner, then:

```sh
node scripts/aws-personal.mjs terraform plan --image-digest=sha256:<digest> --build-id=<manifest-hash> --api-origin=https://forever-tee-api-development.socialqueue.workers.dev
node scripts/aws-personal.mjs terraform apply
node workers/video-renderer/aws-lambda/configure-app-secrets.mjs
bun run --filter @forever-tee/api deploy:development
```

Supply all three release parameters on every later plan. Omitting the image
would propose removing Lambda, which `prevent_destroy` rejects.

## Runtime, retries and rollback

- `STORY_VIDEO_PROVIDER=lambda` selects Lambda. `cloudflare` or an absent value
  selects the existing renderer. Cloudflare warmup is skipped for Lambda.
- Development has eight Lambda slots and two concurrent queue consumers, each
  handing off at most four variants without waiting for encoding. Memory is 3008 MB, timeout 120 seconds.
  No provisioned concurrency, warmup schedule, public function URL or NAT is used.
- Successful configuration schedules direct dispatch through `waitUntil` after
  writing jobs and sending the recovery queue message. Only AWS acceptance runs
  there, bounded to ten seconds, so encoding does not depend on a browser staying
  connected or the Worker's 30-second background lifetime. Queue and direct
  dispatch use the same atomic claim to prevent duplicate work.
- AWS accepts events durably with HTTP 202. That does not mean ready. The R2
  callback commits readiness and sends the existing notification after storage.
  Each invocation expires after 60 queued seconds and has no automatic compute
  retries. Failure records go to a private, encrypted SQS queue.
- A separate 128 MB Lambda returns those failures to the API using the original
  job-and-attempt grant. Only failure callbacks allow a 15-minute expiry grace;
  expired grants still cannot read artwork or upload media. D1 retries the current
  failed job through the recovery queue, never accepted or completed siblings.
  Failed failure-delivery messages retry and then move to an encrypted dead-letter
  queue after five receives. The periodic D1 reconciliation remains the final fallback.
- D1 claims are atomic and fenced by attempt count. Duplicate delivery cannot
  claim a job twice or overwrite a newer attempt's state.
- R2 writes are conditional and SHA-256 checked. Readiness is published only
  after storage acknowledgement. A lost upload acknowledgement can recover
  committed output without re-encoding. Existing objects are identity-checked.
- Artwork reads can retry within a shared 20-second deadline. Invocation and
  uploads do not retry blindly; queue retries recover missing or completed jobs.
- Failed variants do not reset siblings already ready. Three failed attempts
  become unavailable. Stale exhausted jobs do not remain pending forever.
- Readiness notifications use the existing push/SSE path, with D1 recovery on
  reconnect. Gallery navigation caching and existing media URLs are unchanged.

Rollback requires a verified admission pause and drain/reconciliation first.
Restore compatible Worker, renderer and failure-handler releases together; the
older deployed image does not implement the current execution claim. A metadata
file naming a previous image is not proof of compatibility. A Cloudflare rollback
must also restore `STORY_VIDEO_PROVIDER=cloudflare` and queue `max_concurrency=1`.
Keep R2 bindings and objects, immutable D1 records and migration history. Do not
destroy Terraform resources or restore old state as part of rollback. Reopen
admissions only after live verification and explicit rollout approval.

## Verification and scaling gate

```sh
node --test --test-concurrency=1 scripts/aws-personal.test.mjs scripts/aws-personal-terraform.test.mjs
bun run --filter @forever-tee/video-renderer test:lambda
bun run --filter @forever-tee/api exec vitest run src/story-video-jobs.test.ts src/story-video-grants.test.ts src/story-video-notifications.test.ts --maxWorkers=1
node workers/video-renderer/aws-lambda/smoke-app.mjs .data/aws-lambda/fixture-20260828/fixture.json
node workers/video-renderer/aws-lambda/smoke-app.mjs .data/aws-lambda/fixture-20260828/fixture.json tee-white --fail-once
node workers/video-renderer/aws-lambda/smoke-app-confirmation.mjs .data/aws-lambda/fixture-20260828/fixture.json <private-preview-env-file>
```

The smoke test uses the owner's saved portrait. It creates an isolated
development revision, two products and four jobs, sends the real queue message,
and records storage-ready timing. It does not reset existing jobs or charge
paid design operations. It leaves its fixture IDs and report in a unique
`.data/aws-lambda/app-smoke-*` directory for inspection.

The `--fail-once` check intentionally supplies a wrong artwork checksum for one
new test job, verifies failure delivery through SQS, and requires the normal
queue retry to produce the correct video on attempt two. It does not reset
existing customer jobs. Queue smoke timings include queue dispatch delay;
they do not measure the normal post-confirmation direct-dispatch path.

The confirmation check requires a valid preview service credential for the
development API. It verifies authentication before creating fixtures, copies
the saved artwork to a new development draft, and calls the real family API.
It requires four readiness events on the push stream, first-attempt completion,
and successful media HEAD requests through the existing gallery routes.
It never resets an existing draft or prints credentials. Two concurrent live
confirmation checks passed after the approved development credential rotation.
Use the private rotation recovery file for this test, not an export of a hidden
Vercel sensitive variable. Credential rotations must update Vercel Preview,
the GitHub Preview deployment source and the development Worker together, then
refresh the preview deployment. Never rotate production as part of this check.

See [the implementation results](../../docs/aws-lambda-app-integration-2026-08-28.md)
for the deployed image, concurrent render evidence and remaining release gates.

The development limit is not the production capacity target. Before production,
load-test concurrent customers, set queue concurrency and reserved Lambda
capacity together, check regional account headroom, and alarm on queue delay,
Lambda throttles, errors and first/all-ready latency. Lambda quotas and burst
scaling still bound throughput; this implementation does not promise unchanged
latency for 10,000 simultaneous new designs. Tests must distinguish queue wait,
asset read, cold start, encode, upload and client notification time.
