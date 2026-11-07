# Release feedback loop

Run local checks before dispatching a release. Keep iterative PRs in draft. Once the final push has settled, mark the PR ready so the required `check` runs. Fix deterministic failures in the checkout. Recover a failed native mutation through its recorded-pair procedure before any further mutation.

Ordinary application fixes use a focused local regression and relevant package checks before the final push. The complete required hosted suites still run before merge; the final eligible release candidate remains fresh and cache-free. Workflow, release-tooling, policy, dependency, infrastructure, migration and unknown changes still run both complete local suites before pushing.

Validation workflows pin `ubuntu-24.04`, matching the admitted `ubuntu24` runtime for receipt reuse. Exact Node and hosted image versions remain part of validation evidence, so runtime drift still requires fresh checks.

## Monorepo admission

The active root release workflows are generated from the reviewed product sources. They install from the single root Bun lockfile, run product commands from `products/shop`, and require the authoritative exact-main root quality gate before cloud access. `git diff` and full-tree manifests distinguish Shop paths from external `@monorepo/` inputs; shared packages, root configuration and unknown inputs cannot inherit an older qualification.

Protected Wrangler and Terraform configurations are rendered outside the tracked checkout. Their source templates remain unchanged and generated config/plan bytes are sealed in private release evidence. Native candidate clean-checkout assertions stay enabled. The isolated Lambda image receives only its expected account identity during the verified cloud build, and its non-root tests run against that built image configuration.

Operational evidence and dispatch inputs use the protected versioned encryption route described in the product README. Public Actions artifacts contain ciphertext, never provider object versions or private acceptance reports. Keep the same protected key available to authorized coordinator/recovery consumers and retain old versions until their recovery records expire. Current monorepo quality checks supplement every existing product release and qualification guard.

## Commands

```sh
# Once per Playwright version; installs a browser on this device.
(cd apps/web && bunx --no-install playwright install chromium)

# Complete browser suite for broad changes, with deterministic service fixtures.
bun run test:e2e:local

# Complete repository suite for broad changes. Ordinary fixes use focused checks.
bun run check:ci

# On a committed release checkout: offline source/configuration checks.
bun run release:preflight --environment development --lane web
bun run release:preflight --environment development --lane native --operation release
bun run release:preflight --environment development --lane native --operation qualify-all --verify-release native-RUN_ID
bun run release:preflight --environment production --lane native --operation promote

# Add GitHub policy, source freshness and competing-release reads.
bun run release:preflight --environment development --lane web --github

# One status snapshot, including the current or failed step and next action.
bun run release:status --run RUN_ID
```

Replace `RUN_ID` with the numeric Actions run. Preflight describes `HEAD` and rejects uncommitted files. Refresh `origin/main` first; `--github` also verifies that the remote selected branch still points at `HEAD`. Offline output alone cannot prove live permissions or readiness. Every report has `admissionGranted: false`; Actions repeats its own authoritative checks immediately before mutations.

Use `--lane wrangler --github` to compare against the last successful deployment using the same planner as Actions. A comparison against current main alone is not a deployment baseline. Missing, divergent or incomplete history conservatively routes API/renderer work to the native workflow.

The optional `--worker` flag verifies the target environment's Worker capability contract using `FOREVER_TEE_API_SHARED_SECRET`. Supply that environment's existing secret privately; never put it in a command argument or report. This is a read, not a deployment.

The optional `--aws` flag calls only the existing personal runner's exact Lambda concurrency read. It requires the project's private personal configuration and current SSO login. It does not use another profile, read work credentials, provision resources, or execute cloud-only qualification locally. An absent setup or expired session is a blocker, not a reason to fall back.

The GitHub commands use an explicit `GH_TOKEN` if provided, otherwise `gh auth token --user bentbrain`. They never change the CLI's global account selection. Status returns one snapshot. Actions performs deployment admission checks separately.

## Actions budget

Use `bun run actions:usage` before planning a new release batch. The report targets
2,500 hosted minutes per UTC month with a 575-minute weekly warning. It sums
rounded job durations across all attempts, groups them by workflow and identifies
failed-run spend. Completed job inventories are cached on this device; each read
refreshes run discovery and changed attempts. Active runs remain incomplete.
The seven-day subtotal covers only runs created in the selected month, so it
understates the rolling week around a month boundary. This repository estimate
is not GitHub's account-wide invoice or included-minutes balance. The existing
GitHub $10 spending cap remains the final billing control.

The coordinator adds the selected stages' estimated cost before creating a new
execution journal. It refuses a new batch above 2,500 minutes unless supplied
with a specific `--budget-reason "..."`, which it records in that journal.
Batch nonessential work and qualify the final Preview candidate once. Existing
journals can finish or recover without another budget admission. Direct Actions
dispatches do not enforce this local control; use the coordinator for routine
multi-stage work and review usage before necessary standalone operations.

Run `bun run actions:cache` to preview obsolete task snapshots from closed PRs.
`bun run actions:cache --execute` rechecks each PR and deletes only those identified
regenerable caches. It preserves main caches and all release artifacts. Check
this during the weekly usage review. Successful checks also trim accumulated
Turbo task archives to 256 MiB before saving the next snapshot. This limit does
not include the separate Next.js compiler cache. Cache cleanup recovers capacity;
it cannot refund already consumed Actions minutes.

Judge this change on the next ten varied ready PRs and three routine release
batches. Compare total rounded runner minutes and preserved task-cache evidence,
then check the monthly projection against 2,500 minutes. Use measured runner minutes to determine whether the budget target is met.
Use ordinary work for this sample rather than dispatching benchmark releases.

## Earlier checks in Actions

Native Development checks the operation, branch and supplied qualification/rollback ID before dependencies. Production checks the qualification receipt, promotion manifest and qualified Worker/dependency source before cloud preparation. Failures are aggregated so one missing prerequisite does not conceal the next.

The PR workflow runs repository checks and two fixture browser shards in parallel. Each shard collects half of the fixture suite; the first shard also runs the separate PostHog suite. Hosted fixture checks stop at the first failure and cancel the other browser shard; successful runs still execute every test. Local runs collect all failures by default. The required `check` job succeeds only after the repository job and both browser jobs succeed. The shared check action retains its combined suite for main release validation, caches the browser, and saves failure screenshots/traces. `bun run test:e2e:ci` lets Turbo reuse a successful fixture-backed browser result from the checkout's local task cache. Its inputs cover the entire web package, shared packages, patches, dependency manifests/lockfile, the browser/runtime wrappers, the shared check action and its calling workflows, and lifestyle image fixtures. Changes to unrelated release scripts do not invalidate it. Print-executor changes invalidate the API checks that consume them rather than every workspace task. Node version, platform, architecture, hosted image version, fixture settings and browser environment changes invalidate the result. Backend implementation or documentation alone does not invalidate this browser task; API tests and the other repository checks still run through their existing gates. Optional production-mode fixture checks always execute because they consume a separately prepared build. `bun run test:e2e:local` remains a direct, uncached run. The complete local run is required before the final push for broad changes; ordinary fixes run the focused local regression and retain the complete hosted gate.

PRs can save their task/Next snapshots in GitHub's isolated pull-request merge-ref cache scope. GitHub does not expose those snapshots to main or other PRs. First-attempt personal main dispatches may also read and write the existing remote browser cache. PR workflows still receive no remote-cache credentials. Browser and other task keys include the exact Node version, platform, architecture and hosted image version. Failure screenshots/traces are not cached as successful results.

A main release can reuse completed successful validation from Deploy, web Production or native Development only when its full check step actually ran and its preserved input receipt matches. Metadata-only commits may reuse that result when executable inputs, runtime and relevant environment settings are unchanged. A later deployment failure does not invalidate the successful validation job. Reused or skipped steps, PR-authored receipts, other repositories, incomplete runs and rerun attempts cannot establish main-receipt reuse. A failed CI check still blocks release. Task-cache hits are recorded as restored results, not fresh test executions. Deployed camera/purchase tests and live Worker checks remain automatic, uncached deployment gates. Extensive native cloud qualification runs separately and remains an uncached Production admission gate.

For the final ordinary application PR in a release batch, add the
`ci:release-candidate` label while it is still draft, before marking it ready.
That PR executes fresh validation with dependency, task, Next and browser cache
restoration disabled, and forces Turbo execution with cache reads disabled.
Only this fresh result can establish validation for its exact squash commit.
Ordinary PRs retain their existing caches and cannot provide main admission.
Do not select policy, configuration, dependency or release-tooling PRs: those
must run full main validation anyway. Selecting one final candidate avoids
forcing every intermediate PR through a cold check.

For a selected candidate, each repository/browser job checks out protected main first, prepares Node, and uses the
protected recorder to preserve a small runtime/fixture-environment digest before
checking out PR files. The test action pins that exact Node version. PRs retain
read-only repository permissions and never receive main-cache or release credentials.

The main-side verifier checks the latest successful first-attempt required job,
all three explicitly fresh validation steps and their protected cache-policy bindings,
their ordered steps, the artifact's GitHub-assigned creation time, immutable ID and
archive digest, and the current runner/fixture environment. The three protected version-two records must identify the expected job, agree on the tested merge, and predate their validation steps. Legacy combined-job evidence remains supported. It independently
reads GitHub's Git objects to require identical tested and merged trees, the
exact PR head and a squash parent matching the tested protected base. Validation
policy, configuration, package manifests, scripts, lockfiles, patches and unknown
paths must be unchanged from that base. Renames count as deletion plus addition.
A changed base, policy or runtime, another merge method, a fork, rerun, missing or
late artifact, insufficient read permission or any uncertain evidence falls back
to full checks. No PR claim of successful validation is sufficient on its own.

PR cache entries can contain writes from earlier unreviewed commits. A cached
PR check is therefore insufficient even when the final source tree is reviewed.
The selected candidate starts on a fresh hosted runner, restores no caches and
forces validation tasks to execute. Its fresh-step selection and runtime record
come from the same immutable pull-request event. Changing a label after a cached
run cannot turn that run into trusted evidence. Set the label before the final
ready event to avoid an extra check.

Recorder introduction requires a full check because the protected base must
already contain the recorder before its evidence can support reuse.
Validate the first eligible ordinary PR/release pair using
its real provenance; do not dispatch a benchmark release. Production admission,
live camera/purchase checks, cloud qualification, drains and rollback checks are
unchanged, including full qualification for release-tooling changes.

Web-only Preview accepts exact current main, as well as an eligible web-only branch containing current main. It does not require a temporary branch or an environment-policy edit. GitHub's Preview environment must still permit the selected branch. Branch Preview admission verifies the exact remote commit, current-main ancestry and a canonical open PR against that main. Both main and the branch must pass all canonical Quality jobs, native CodeQL and exact-head independent review. Only storefront changes and the separately reviewed CodeQL evidence ledger may differ from main; release controls, shared dependencies and native mockup assets remain pinned. Branches run the full fallback validation, and admission is repeated before storefront publication. Both web release paths check live Worker capabilities before dependency installation or Vercel preparation and retain the later pre-promotion check.

Native workflow titles identify operation, mode, referenced release, branch and source. Coordinated runs also include their journal correlation ID. Generic stage/count status appears publicly. Full console diagnostics and child stdout/stderr use the independently authenticated encrypted log route in the product README, including errors before private cloud evidence is saved. Private deployment details remain in encrypted diagnostics and immutable cloud records. A summary-write failure cannot interrupt a release after a successful mutation. Drain progress is rate-limited to one message per minute; fences and ownership checks are unchanged.

## Coordinate an authorized release

Use a clean checkout of current main. The command prints its plan by default. Add `--execute` only when the release itself is authorized.

```sh
# Print Development release → web-only Preview with deployed browser checks.
bun run release:coordinate --target preview --mode full

# Execute that sequence through the existing guarded Actions workflows.
bun run release:coordinate --target preview --mode full --execute

# Resume the exact journal path printed by the command.
bun run release:coordinate --journal .data/release-coordinator/JOURNAL_ID.json --resume --execute

# Independently print the qualification plan for the exact live Preview pair.
bun run release:coordinate --target qualification

# Run that reviewed plan without another deployment.
bun run release:coordinate --target qualification --execute

# After reviewing qualification and source-bound automated browser evidence:
bun run release:coordinate --target production --mode full --promotion-file .data/review/promotion.json --execute
```

The coordinator pins the checkout SHA, persists each dispatch intent before contacting GitHub, and discovers the resulting run by its unique title. It verifies repository, workflow, source, operation, supplied release ID and first attempt before advancing. Every stage repeats preflight. A workflow-side check also rejects a main commit that changed between preflight and dispatch.

New Preview journals stop after deployment health and deployed browser checks. Native-only auto plans run `preview-smoke.yml` against the unchanged storefront, including the existing bounded camera-to-design/cart journey with no test retry. Plans that deploy web retain its deployed browser suite, which already includes that journey. Preview completion does not mean Production qualification. Its successful source-bound camera smoke can supply automated acceptance after qualification, so do not run that journey twice. The separate `qualification` target pins the exact live Development release and runs only qualification, with cleanup recovery when eligible. Production uses a separate journal with the reviewed promotion input and runs native promotion, including its canary, followed by web Production. The coordinator cannot invent acceptance or carry a qualification across incompatible source changes.

The private journal lives under ignored `.data/release-coordinator/`. Resume it after interruption; never edit it to repeat a mutation or create a replacement merely because a response was lost. An uncertain dispatch stops until the original run can be discovered. A failed run stops the sequence for inspection and recorded-pair recovery. `--once` performs one coordination pass and exits. Normal observation is bounded to one hour, after which the same journal can be resumed. A hard process kill can leave a `.lock` file containing a PID. Check that process before removing a stale lock; never run two coordinators against one journal.

## Reuse an unchanged native image

For an eligible API change, choose `--mode api` in the coordinator or `release_mode: api` in the native workflow. This replaces Terraform image preparation with a versioned proof that the live image and source digest match the existing candidate. Both environments require the current unpaused release's immutable preparation, completed runtime evidence and unchanged live Lambda configuration. Runtime and pause ownership are checked again before cutover. Actual startup probes still run. API preparation advances the existing print executor generation only when its bundle and configuration match its verified baseline. A missing executor or changed inputs requires the full lane; the shared pause, drain and evidence checks still apply.

Eligibility is measured from the active recorded release's source, not from the previous Git commit. API source, storefront files and documentation are eligible. Infrastructure, dependencies, migrations, renderer assets, release scripts and unknown or divergent history require `full`. The first release containing these tooling changes therefore needs the full lane. Missing or inconsistent evidence stops before the release pause; the workflow does not silently choose another lane.

Policy-3 automatic plans also select `full` for known print preparation/execution sources,
the executor's shared observability code and its limits contract. These can
change the separate print-executor bundle even when the Lambda image is reusable.
Test-only edits retain image reuse. This changes native lane selection without
forcing an unchanged storefront deployment. Cloud preparation still verifies the
actual executor bytes and configuration; historical policies keep their plans.

API mode retains the paired Worker release, proved natural drain, migration verification, Production fallback rehearsal, monitoring and canary. Relevant Development qualification is required separately before Production, rather than automatically before Preview is available. It saves image provisioning work; it does not claim that API changes cannot affect rendering. These cloud checks still run only in Actions.

## Promotion data

The legacy `infra/story-video-lambda/production-promotion.json` holds candidate, qualification and acceptance references. Existing committed records remain supported. Prefer the source-bound promotion input described below for new qualification and phone receipts. Do not manufacture acceptance reports or replace the owner’s words with a boolean inferred by an agent.

Production still verifies the original successful first-attempt runs, repository identity, immutable object versions and checksums, image digest, source archive, live cloud qualification, reviewed automated browser or actual phone acceptance and alert receipt. Moving the selected release facts into a manifest changes where they are reviewed, not the evidence required for admission. Historical evidence IDs used by recovery remain available.

## Coverage and retained boundaries

The local browser suite checks the cold home-to-create transition, desktop phone handoff, empty-cart layout, shirt/tote option state and mobile consent. It uses a base-product catalogue fixture, an empty saved-design list, Shopify fixtures and a real Next development server. External browser requests outside the explicit fixture list fail the test; server requests have no live-service fallback. It cannot certify production-mode caching, a configured product purchase, camera upload processing, saved-design deletion, Cloudflare bindings, Shopify checkout or Lambda rendering. The existing deployed browser suite and real Worker/D1/R2 integration tests retain those responsibilities.

Root package/lockfile changes still conservatively require fresh Worker qualification, even when motivated by tooling. Use the coordinator for dispatch and observation. The API lane reuses an unchanged image through the existing cloud qualification and recovery protocol.

Keep the guarded recovery/bootstrap workflows available for manual recovery.

## Component selection

`bun run release:coordinate --target preview` now defaults to `--mode auto`. It reads authenticated environment deployments and compares each component with its own last successful first-attempt main release. The printed `selection` includes the baseline runs, changed paths, selected workflows and qualification policy. New plans return `estimatedMinutes: null` until comparable observations support an estimate; use observed timings to estimate duration.

Shipping/backend changes omit an unchanged storefront. Storefront changes omit an unchanged native release. Shopify notification files do not force image preparation and template-only changes dispatch no application workflow. Publish and verify those templates through the notification workflow and Shopify. Missing or divergent history, unknown deployment operations, release policy, unknown shared packages and dependency changes select the full path.
Reviewed application-contract source changes select web/API and may reuse the
unchanged image, while retaining full cloud qualification before Production. An interrupted native release cannot establish a reusable baseline.

The coordinator checks the source comparison again when resuming and rereads live baselines before each dispatch and completion. A different deployment stops the pinned plan. Only the journal's own verified completed runs can replace its original baselines. New explicit `--mode full` and `--mode api` Preview plans also omit automatic qualification. Existing journals retain policy version 1 and their original stages, estimates and correlation IDs. Resume old journals from their pinned checkout; never rewrite them to adopt the new policy. Full rendering qualification remains required unless the isolated shipping or commerce evidence below proves the narrower path. The owner-authorized automated browser route replaces repeated phone acceptance for backend repairs.

`release:status` includes step durations, initial queue time and observed job time. Job durations can overlap and do not equal elapsed time or billed runner minutes. Missing timestamps and unavailable billing data remain unknown. Coordinator completion includes dispatch-to-start and execution durations for its selected stages. Combined native workflow steps still require the existing timestamped release events to inspect drain and provisioning separately.

## Recover completed qualification cleanup

New full qualifications preserve their functional summary and fixture inventory before cleanup. The final `qualification-receipt` references that summary and a separate successful cleanup receipt. Select the final receipt for promotion; a new functional summary alone cannot satisfy Production admission. Existing successful legacy receipts remain supported.

If the isolated shipping test process fails, its bounded, redacted test messages appear in the run log and in `qualification-shipping-failure.json` in the immutable release evidence. Raw child stdout/stderr is excluded because remote binding credentials can appear there. Failure evidence does not authorize promotion or bypass the existing cleanup and first-attempt rules.

If `qualify-all` fails after preserving its functional pointer artifact, the coordinator can dispatch `cleanup-qualification` once in a separate, nested journal. It uses the original run's exact S3 object version and checksum. A lost dispatch acknowledgement resumes by correlation. A failed recovery stops for inspection rather than creating another recovery run. The successful recovery run becomes the selected qualification run, while the failed functional run remains failed in GitHub history.

Manual recovery uses the existing native Development workflow with `operation: cleanup-qualification`, the original `verify_release`, and `qualification_reference` containing the immutable functional-summary reference JSON from the original artifact. Preflight accepts the same JSON via `--qualification-reference`. Recovery requires unchanged main source and the same live, unpaused release, Worker version, bundle/resources digest and renderer pair. It verifies all five original functional reports before deleting anything. It cannot recover an incomplete functional suite or substitute a different fixture inventory.

Cleanup saves and reads back inventory before deletion. Each fixture's ownership, payment/fulfilment references, active jobs and exact inventory are checked inside the same D1 batch as its nine deletions. An uncertain database acknowledgement triggers an absence read, not a repeated write. Object work runs at most four operations concurrently. Recovery inspects remaining objects before deleting them, and retains objects referenced elsewhere. Shared content-addressed print blobs remain with the existing storage-maintenance collector, which owns their cross-design reference checks.

Routine qualification now verifies lifecycle policy read-only. The Development plan/release infrastructure path retains policy reconciliation and readback. No routine qualification can quietly repair a changed lifecycle policy. The cloud qualification and the new recovery path remain Actions-only.

## Shipping qualification

The independent auto qualification plan can select `qualify-components` for changes confined to
`workers/api/src/printify-webhooks.ts`, its tests and release metadata. It needs a
successful main qualification artifact containing the full renderer input
manifest. Shared Shopify clients, scheduler, entrypoint, schema, dependencies,
release scripts and policy changes still require full qualification. The planner
compares all remaining executable inputs, and the cloud job independently checks
the immutable receipt, image, Worker bindings and live Lambda configuration.
Missing evidence or runtime drift selects the full suite before creating fixtures.

The shipping suite runs signed webhooks, parcel reservations and scheduled
reconciliation against a newly created isolated Development D1 database. Shopify
responses are simulated and the test process receives no provider credentials.
It verifies one notification for a shared parcel, concurrency, uncertain responses,
separate parcels, Australia Post naming and direct tracking URLs. The temporary
database must be removed and absence confirmed. A stranded database blocks the
next creation and must be inspected using its saved creation receipt.

Component qualification also runs the live family video smoke. It preserves the
existing release drain, rollback and cleanup requirements. Production may reuse
an actual owner phone report only for the original fully qualified renderer pair
referenced by that shipping receipt. New renderer evidence and the first release
of these tooling changes still require the full path. Backend repairs may use the owner-authorized automated browser route described below.
The coordinator downloads only bounded pointer artifacts from authenticated
successful first-attempt main workflows. Private immutable records are verified
again in Actions, including after cleanup recovery.

## Promote reviewed receipts without a source commit

The owner authorized autonomous alert repairs on 2026-10-05 and extended the automated route to backend incident repairs on 2026-10-11. That task may use
schema 2 promotion inputs with `automated-cloud-and-browser` acceptance instead
of a phone report. This route requires fresh full cloud qualification or the verified isolated commerce qualification linked to original full renderer evidence,
including verified fixture cleanup, and a successful first-attempt
`preview-smoke.yml` run at the same source. Production downloads that run's
original before/after browser observations and verifies that the native Preview
release matches the qualified pair and neither deployed component changed
during the check. Legacy shipping-only evidence cannot satisfy automated acceptance. New commerce evidence includes the full paid-order journey, strict rejection cases and the independently authenticated unchanged renderer chain.
CI, immutable source/image evidence, alert delivery, pause/drain ownership,
canary, rollback and live configuration verification remain mandatory.

Use the successful `preview-smoke.yml` stage already recorded in the Preview journal, at the same `expected_source` and unchanged native/web pair. Qualification does not invalidate that browser observation. If the Preview path has no such original artifact, dispatch the browser workflow once after reviewing usage and saving intent. Generate the request with:

```sh
bun run release:promotion-input --qualification .data/review/qualification.json --preview-run BROWSER_RUN_ID --output .data/review/promotion.json
```

For a newer image, review its original authenticated build and immutable candidate
receipt first. Save only its exact `sourceDigest`, `imageDigest`, `buildRunId` and
build `sourceCommit` in `.data/review/image-candidate.json`, then add
`--candidate-manifest .data/review/image-candidate.json` to that command. Use
`--candidate` when its immutable receipt pointer is outside the committed
Development candidate file. The generator requires the reviewed build ID and
source digest to match that pointer, and the image to match qualification. It
never derives the build source from the application source. Omitting the option
retains the committed candidate guard. Actions still authenticates the original
build, source archive, image, qualification and browser artifacts before
admission; the private candidate file alone cannot authorize promotion.

Then use the Production preflight and coordinator below. Automated acceptance
records the standing authorization and authenticated run references; it never
creates a phone report or claims real phone playback. Earlier references to
required owner phone acceptance in this document describe the original schema
1 route, which remains supported for owner-reviewed releases.

After qualification succeeds, save its completion reference as the usual
qualification JSON and record the owner's actual response for the reviewed
Preview. Keep these review files under `.data/`; do not invent acceptance.
Create a bounded promotion request from those existing records:

```sh
bun run release:promotion-input --qualification .data/review/qualification.json --phone .data/review/phone.json --output .data/review/promotion.json
bun run release:preflight --environment production --lane native --operation promote --promotion-file .data/review/promotion.json --github
bun run release:coordinate --target production --promotion-file .data/review/promotion.json
```

Review the printed plan, then use `--execute` with a new Production journal.
Resume that journal after interruption. The request is pinned in the journal and
sent as structured workflow input. Production authenticates the original runs,
reads exact object versions and checks the image, qualified source and phone
report. It saves the complete request in the private immutable artifact bucket
before application mutations. A missing acknowledgement stops the operation.
The final candidate evidence points to that saved request. No source commit is
needed solely to select the qualification and phone receipts.

The generator reuses the reviewed image candidate. A new renderer image still
requires its reviewed candidate source and infrastructure pins. Alert delivery
acceptance remains the existing reviewed infrastructure record. Legacy committed
promotion records remain supported; new input files require completed receipts
with separate cleanup evidence.

## Validation reuse and measurements

Successful first-attempt main checks publish component input digests and the
actual Node/runner image and build-environment digest. Only authenticated first-attempt main validation jobs that executed the checks
can establish reuse. A later deployment failure does not invalidate a completed
successful validation job. PR artifacts, skipped
checks, missing receipts, unknown runner images and changed inputs cannot. A
metadata-only source commit can reuse the result when every executable component,
policy, lockfile, toolchain and relevant build setting still matches.

Native workflows publish `release-timings-RUN_ID` artifacts containing individual
stage start/completion records. These distinguish preparation, deployment, drain,
functional qualification and cleanup. Interrupted stages retain only their start
record. Timing collection never retries a release operation or changes admission.
`release:status` continues to report observed queue/job/step durations.

```sh
bun run release:measurements .data/release-coordinator/*.json
```

The report groups comparable targets, modes, changed components, cache states and
cleanup recoveries. Unknown cache state remains explicitly unknown. Median and
p95 require ten completed samples within one group. Review/coordination gaps and
billed runner minutes are separate; job durations are never presented as billing.
Policy versions are separate measurement groups, so old deployment-plus-qualification journals cannot seed estimates for the new Preview path. No new-path duration is claimed before it has been observed.

The weekly scheduler runs Monday at 03:00 Brisbane time. It dispatches full
qualification only when the recorded Development pair matches current main,
no Development workflow is active and the previous qualification is successful.
A full qualification within six days skips that week's repeat. A recent narrow
shipping qualification does not replace the weekly full suite. The scheduler
saves and reads back its immutable dispatch intent before its single POST. It has
no AWS/Cloudflare credentials and never deploys an application. A failed or
uncertain request requires inspection; rerunning the scheduler is refused.
The weekly check preserves the existing renderer baseline selected for owner
acceptance. It does not publish a replacement baseline pointer that would make
an unchanged pair's accepted phone report appear stale. Its full functional and
cleanup receipts remain available for inspection, including after recovery.

Crawler metadata checks allow one retry of an interrupted GET after a TCP
connection reset. They still reject HTTP errors, redirects, repeated resets and
missing indexing metadata. This uses Playwright's bounded network retry option,
not a retry of the test suite. A real loopback TCP-reset regression test covers
recovery and the failure boundaries. Each crawler route has its own test deadline so cold route compilation does not consume a shared six-route budget. HTTP, redirect and noindex assertions remain unchanged. See [Playwright request retries](https://playwright.dev/docs/api/class-apirequestcontext#api-request-context-get-option-max-retries).


For task input boundaries, runtime separation, output restoration, remote-cache
measurements and the retained PR trust boundary, see
[validation cache optimisation](validation-cache-optimisation-2026-09-15.md).

## Qualification policy and source binding

The exhaustive rendering families, retry exhaustion, injected faults, termination
recovery and load suite is independent of Preview deployment. Existing native
Development `workflow_dispatch` operations remain available individually, and
`qualify-all` remains the complete Production-admissible suite. A successful
individual diagnostic operation or camera smoke cannot satisfy full admission.
The weekly full qualification also remains enabled, subject to its existing
source, activity and previous-success guards.

| Changes since the relevant evidence | Required native Production evidence |
| --- | --- |
| Web-only, docs or notification templates, with native unchanged | Existing qualified native pair; deployed web checks still run |
| Proved-pure Printify identity modules with identical renderer inputs and live configuration | Fresh entire paid-order D1 journey and live video/print smoke, linked to original full renderer evidence |
| Shipping leaf under the historical shipping boundary | Legacy shipping qualification and original renderer/phone evidence; five-minute drain retained |
| Worker queues, retries, admission, shared entrypoint or other API behavior | Fresh full qualification for the deployed pair |
| Renderer/assets, infrastructure, migrations, dependencies, shared contracts, release policy or unknown/divergent history | Fresh full qualification; full deployment lane where image-reuse rules require it |

The qualification planner uses authenticated deployment history and the original
renderer receipt's source. Every native promotion still verifies immutable
version/checksum-bound reports, successful first-attempt workflow identity,
exact image, Worker bundle/resources, fixture cleanup and source-bound acceptance.
Shipping reuse independently recomputes the complete renderer manifest and
checks live configuration. No user-supplied `low-risk` flag can skip these checks.
Production and preflight now reject any native-relevant path change after the
qualified source, including migrations, infrastructure and release scripts.

A camera repair in the shared Worker entrypoint is conservatively a full-suite
change for Production even when its renderer image is unchanged. It can reach
Preview before that suite runs. Broadening reuse further needs proof that the
changed code cannot affect native admission, retries, persistence or rendering;
image equality alone does not establish that.

The standalone smoke workflow uses the same Development concurrency group,
checks the native and unchanged web deployment baselines before and after the
journey, and records those sources. It uses Preview credentials and no AWS role.
It does not establish a new deployment baseline or a qualification receipt.
Native release startup/status checks and web deployment checks remain automatic.
The low-level native release dispatch deploys only the pair; use the Preview
coordinator to include the storefront camera gate before calling Preview ready.

## Drain and validation costs

Web-only and metadata-only plans do not pause native admission or drain renders.
Native replacements with changed or unknown rendering handlers retain the five-minute fence, including ordinary image reuse.
Development verifies a 120-second Lambda runtime and 60-second async event age;
transfer grants can remain valid for 180 seconds. The Worker replacement changes
the endpoints used by that in-flight work. A zero rendering-row count does not
prove that outstanding async delivery, callbacks or upload grants have settled.
After the fence, Development recovers eligible old rendering rows without
resetting attempt counts, then requires no active renders before cutover.
Production never uses that recovery UPDATE: it requires natural drain, at least
five minutes and a continuous 60-second quiet observation, and stops paused if
work remains after twenty minutes. For the isolated commerce boundary only, a sealed API preparation proves every rendering handler, grant, queue consumer, runtime and dependency identical. Existing grants therefore retain their handler protocol. Both environments may then use a continuous one-minute natural quiet drain across video, print, image and artwork work, rechecking pause ownership throughout and making no lease recovery writes. A zero count alone, an API flag or image equality cannot select this path.

PR types, lint, unit tests, pipeline checks and focused browser regressions remain
blocking merge. Release validation reuse requires authenticated main receipts or the
independently verified protected PR evidence described above, with matching
complete source, toolchain and environment. The September 17 qualification and web runs already reused the native
run's repository checks, so removing those repeated workflow steps would not
save another full check. A PR-authored receipt is never promoted to trusted main evidence. Native Production's focused evidence-guard tests remain uncached.

See [measured September 17 costs](release-preview-qualification-2026-09-17.md)
for the observed time moved off the Preview path and the remaining uncertainty.

## Clean fixtures from an early failed qualification

`cleanup-failed-qualification` is a separate Development operation for a failed
`qualify-all` or `qualify-components` run that never produced a complete functional
summary. Its `qualification_reference` is the original immutable
`qualification-cleanup-inventory-...json` object reference, including version and
SHA-256. It cannot accept a functional summary or create a passing qualification.

From the new, committed cleanup implementation on main, preflight the exact
original release and inventory reference. Dispatch `native-development.yml` with
`operation=cleanup-failed-qualification`, `release_mode=full`, the original
`verify_release`, that inventory reference, and `expected_source` set to the
current cleanup commit. Use structured workflow inputs or a JSON request file;
never substitute the cleanup commit for the original failed run's source.

The operation authenticates the original failed first-attempt GitHub run and its
sealed release preparation. The current application must still be that release
or its exact verified rollback; both paths verify the actual Worker, renderer
and executor identity. Cleanup waits at most one minute for fixture print and
video jobs to settle, then atomically rejects active work, paid/fulfilment
references, changed ownership, changed inventory or a changed release generation.

Output keys may have completed after the failed inventory was saved. The operation
preserves that original snapshot, seals a reviewed refreshed snapshot for the same
fixture identities, and journals its immutable reference before deletion. That
journal retains completed keys if database deletion succeeds but later object
cleanup fails. Recovery reads absence rather than repeating an uncertain delete.
Shared print blobs remain with their existing reference-aware maintenance path;
staging inventory remains with its attempt-scoped cleanup and lifecycle fallback.

The resulting `failed-qualification-cleanup-receipt.json` records
`qualificationComplete: false`. It stays in the cleanup run's evidence namespace,
is excluded from deployment and renderer baseline discovery, and cannot support
Production promotion. Review a failed recovery before dispatching another
first-attempt recovery; never rerun the original failed qualification or fabricate
a complete-summary receipt merely to unlock cleanup.

### Resume a rollback that restored providers but failed final verification

`recover-rollback` is a Development-only first-attempt main operation. It accepts
`rollback_release` as the **failed rollback run**, not the application release it
was undoing. Supply `rollback_reference` with the exact versioned
`source/releases/native-FAILED_ROLLBACK_RUN/rollback.json` key, version and SHA-256.
The cleanup/recovery code source is the current reviewed main commit; the original
rollback source and predecessor remain pinned by authenticated GitHub run and
matching immutable D1/S3 evidence.

Run the committed-source preflight before dispatching `native-development.yml`:

```sh
bun run release:preflight --environment development --lane native \
  --operation recover-rollback --rollback-release native-FAILED_ROLLBACK_RUN \
  --rollback-reference "$ROLLBACK_REFERENCE_JSON" --github
```

Use the same `rollback_release` and `rollback_reference` in the workflow, with
`operation=recover-rollback`, `release_mode=full` and exact `expected_source`.
This verifies the existing paused rollback, its original target, restored Worker
bytes/version/resources, queue consumer, Lambda pair, executor generation and
staging lifecycle. It requires the original executor restoration journal, observes
the existing full drain and runs a fresh startup probe. It then writes the original
rollback's final verified record and resumes that original ID. It does not deploy
Workers, apply Terraform, restore queue settings, create/delete namespaces or
select a new predecessor. A different pause owner, incomplete restoration, changed
provider state or uncertain evidence leaves admissions paused.

Cloudflare's script `/settings` and `/content/v2` may describe the latest uploaded
version after a historical rollback. Active bindings and compatibility settings
are verified through the single 100% deployed version's immutable `resources`,
with deployment reads before and after inspection and the recorded resource
checksum. Saved historical bytes provide the matching content proof. Recovery
review/startup evidence belongs to the recovery run; the original rollback journal
is preserved. This operation creates no qualification receipt and is not a new
application deployment baseline.


## Ten-minute routine path

Policy-3 automatic plans target ten minutes from the final source's Preview batch
start through verified Production. `release:measurements` reports that entire
journey, including qualification, review gaps and queue time, with `withinTarget`
false for an overrun and unknown for incomplete or ambiguous lineage. Verify this target with normal releases before claiming it as a measured duration. Never cancel a mutation or bypass a failed gate to meet the target.

Routine Printify identity fixes compare the two pure provider identity modules
with a full renderer baseline. The new commerce boundary keeps the shipping
module in the renderer hash; shipping edits cannot select its shorter drain or
renderer reuse. Any new shared importer,
unsafe execution/import, changed entrypoint, dependency, schema, configuration,
policy, renderer input or live-runtime drift rejects reuse. The independent
commerce qualification runs 32 paid-order and shipping cases against a new D1
database with controlled provider/Shopify sinks, no real provider mutations and
verified database/fixture cleanup. The whole successful journey includes the
expanded disabled-variant response, omitted provider-populated phone and empty
HTTP-200 production acknowledgement that #1003 encountered. Changed supplied
phones, SKUs, addresses, fraud, leases and provider identities remain rejected.
A live video/print smoke still runs; renderer exhaustion, fault, termination and
load reports come from the independently verified unchanged full baseline.

Use `--mode auto` for Preview and Production. It omits unchanged web deployments.
Reuse Preview's original successful camera-smoke artifact when generating schema-2
promotion input, rather than dispatching a second acceptance run. Generation now
records `owner-2026-10-11-automated-backend-repair`; legacy alert authorization and
actual schema-1 phone reports remain readable. All artifact/source admission,
personal credential boundaries, canary, rollback and live control checks remain.
Existing policy-1/2 journals preserve their stage sequence. This policy/tooling
change itself needs the broad lane and a new full renderer baseline before later
routine contract fixes can use it.
