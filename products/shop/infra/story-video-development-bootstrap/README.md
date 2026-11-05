# Development state and CI bootstrap

The Production runtime-access bootstrap applied at 22:40 UTC on 2026-08-28.
Current remote bootstrap state is serial 27 with 23 managed resources. Nine
separate runtime/invoker IAM resources were created and the Production CI
inline policy/boundary now match `production-release-policy.json`. Development
permissions and retained snapshots are unchanged. No service key or application
deployment was created. Its one-shot journal is consumed. See the
[runtime access record](../../docs/native-lambda-production-runtime-access-2026-08-29.md).
The older serials and foundation-only permission descriptions below are history.

The Production SNS read correction applied at 21:43 UTC on 2026-08-28. Current
remote bootstrap state is serial 26 with fourteen managed resources. It changed
only `GetSubscriptionAttributes` to the exact Production topic ARN in the CI
inline policy and boundary. Its separate journal is consumed. Development
permissions and the retained local snapshots are unchanged. The historical
serials and operation descriptions below must not be used to replay a bootstrap.

The shared bootstrap now also owns the separate Production foundation CI role.
Its reviewed three-addition, one-policy-update plan applied on 2026-08-28 at
21:04 UTC. Current remote bootstrap state is serial 25 with fourteen managed
resources. Development permissions are unchanged. The Production role cannot
write IAM or deploy applications. Its journal is consumed. See the
[Production foundation record](../../docs/native-lambda-production-foundation-2026-08-29.md).
The Development-only status and command history below predate that addition.

Current status: the original creation, CI activation, Development release policy
and narrowly scoped startup-probe permission updates have all applied. Their one-shot journals forbid replay. The
role is active with the exact checked-in `development-release-policy.json`, not
just its original inspection permissions. Workload state is now remote; this
bootstrap's own state is now remote in the separate `story-video/bootstrap/terraform.tfstate`
key, encrypted with KMS, versioned and configured for S3 locking. Development CI
cannot access that key. The original local state/backups remain private and
unchanged. The one-shot migration journal forbids replay. See
[CI access](../../docs/native-lambda-development-ci-access-2026-08-28.md) and
[migration](../../docs/native-lambda-state-migration-2026-08-28.md).
The older command sequences below document those operations, not commands to
repeat against the current source/state. Development paired deployment, rollback
and initial cloud qualification have since completed. See
[runtime recovery](../../docs/native-lambda-runtime-recovery-2026-08-29.md).

The active remote bootstrap state is now serial 24, with the original lineage
and eleven managed resources. The health-probe update changed only the CI inline
policy and matching boundary, adding invocation of the two exact Development
functions. The current policies are 5,943 bytes and do not grant Production or
IAM write access. Their historical role/policy descriptions are not the current
permission specification; the checked-in JSON is authoritative. See the reviewed
plan and apply evidence in the runtime recovery record. Do not replay any
creation, migration or policy journal, or apply a retained local snapshot.

Bootstrap migration completed 2026-08-28 15:05 UTC. Review
`a0b88ba7e84f8d7e24ad179080aafa248dc5477b47435b6e6d51c76da40c9538`
preserved lineage `{{SHOP:resource_7ee824431a13}}`, serial 23, eleven managed
resources and one OIDC data source. Conditional creation returned object version
`TE__SZq3HFoH.x2i.YsJeEmay3sVMgOx`. The remote state exactly matches the latest
reviewed policy-apply snapshot. No application or IAM resources were changed.
Private evidence is in `.data/terraform-video-bootstrap/bootstrap-migration-PrvT1g`.
Future bootstrap changes must use this remote backend; never apply retained local
snapshots or replay the historical creation/policy commands below.

This module provisions only Terraform state storage and a disabled Development
CI identity in personal account `{{SHOP:awsAccountId}}`, Sydney `ap-southeast-2`. It does
not deploy a Worker, update Lambda, run CodeBuild, migrate renderer state or add
production access. The owner approved preparing this infrastructure on
2026-08-28, subject to review of the exact policies and saved plan before apply.

The current 11-addition saved plan and exact scopes are recorded in the
[approval document](/Users/example/.codex/worktrees/71d3/shirt.shop/docs/native-lambda-development-bootstrap-plan-2026-08-28.md).
The owner subsequently approved that plan and a one-time guarded local apply.
It was applied successfully. See the
[apply record](/Users/example/.codex/worktrees/71d3/shirt.shop/docs/native-lambda-bootstrap-applied-2026-08-28.md).
The later activation and remote-state migration completed. The command history
below includes the earlier disabled-role/local-backend stages and must not be
used to infer current state or authorize a replay.

Read `docs/aws-personal-setup.md` and root `AGENTS.md`. All authenticated local
AWS/Terraform operations must use `node scripts/aws-personal.mjs`. The runner
has a fixed module path, strips inherited credentials and Terraform settings,
and verifies personal SSO before any Terraform command. Never invoke Terraform
directly or use another profile if personal authentication expires.

## Resources and permissions

The module defines a private state bucket with versioning, TLS enforcement,
KMS encryption and no version-expiry policy. A dedicated single-region key has
automatic rotation and a 30-day deletion window. Destruction is prevented in
Terraform. The bucket policy denies deletion of the Development state object
and its historical versions. The lock object remains deletable for unlocking.
KMS writes require the exact created key ARN, so even writes relying only on
bucket defaults are denied.

The CI role's inline policy and permissions boundary are identical. Both allow
read/write of one Development state key and its lock, lock deletion, scoped KMS
operations through Sydney S3, bucket configuration reads and inspection of the
two Development functions, ECR repository and CodeBuild builds. KMS operations
require this key's alias and exact state/lock object encryption contexts; no KMS
administration is granted. There is no IAM access, state-version deletion,
build start, Lambda invocation, workload mutation, production resource access,
role switching or public endpoint. A later release policy needs its own review.
`BatchGetBuilds` uses the exact Development project ARN, as required by the
[AWS authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_codebuild.html).

The existing GitHub OIDC provider is a data source only. Discovery confirmed the
personal provider already exists and permits audience `sts.amazonaws.com`.
The repository API returned prefix
`repo:bentbrain@{{SHOP:githubOwnerId}}/bent-mono@{{SHOP:githubRepositoryId}}`. Trust requires that exact prefix
and `environment:Preview`. The deployed explicit Deny still disables assumption.
Protected Preview now permits only `main` and the current performance branch;
Production permits only `main`, with no tags. Signed OIDC verification in Actions
run {{SHOP:resource_5dafa3f50f08}} established the exact ID-bearing subject above. The pending
activation removes only this Deny and changes the role description/output; its
runner verifies the live protections and that exact successful run again. Do not
log or retain raw OIDC tokens.

## Guarded planning

The creation workflow below is historical and intentionally rejects the current
activation edit. Its one-shot apply is consumed. For the pending activation, after
guarded personal SSO login, use:

```sh
nice -n 15 node scripts/aws-personal.mjs terraform bootstrap activate-ci plan
```

Inspect the returned private plan and SHA-256. Only the exact role trust update
and enabled output are accepted; existing boundary/permissions must be unchanged.
Apply that saved review/hash through `terraform bootstrap activate-ci apply`.
The runner preserves private state/backup snapshots and durably records intent
before the one-time apply. It rejects any replay or changed plan/source.

### Original creation workflow (do not replay)

Run from the exact `71d3` worktree:

```sh
nice -n 15 node scripts/aws-personal.mjs terraform bootstrap init
nice -n 15 node scripts/aws-personal.mjs terraform bootstrap validate
nice -n 15 node scripts/aws-personal.mjs terraform bootstrap fmt
nice -n 15 node scripts/aws-personal.mjs terraform bootstrap plan
```

`fmt` checks formatting without rewriting files. Each plan uses a new mode-0700
directory under `.data/terraform-video-bootstrap/review-*`. The binary plan,
full JSON and review stay private. The review records hashes of the plan and
module/lockfile, exact IAM permissions and resource actions. Only creations and
no-ops of the eleven bootstrap resources and reads of the existing OIDC provider
are accepted. Changes to existing resources, imports, moves and deletions stop
for review. A failed review retains its files and does not deploy anything.

Inspect a saved review with its exact returned ID:

```sh
node scripts/aws-personal.mjs terraform bootstrap show --review=review-ABC123
```

The example ID is not a real plan. Inspection rejects changed plan/source
hashes and re-extracts the binary to check the saved review's contents. These
local hashes detect changes; they are not a signature or an approval. There is
a one-time apply command pinned to the exact approved review ID, plan hash and
module hash. It creates an exclusive, synced start journal, saves private copies
of existing state/backup files, checks resource-name collisions and verifies
personal identity again before applying the saved binary. It never creates a
new plan implicitly. The journal now prevents replay. General apply, imports,
destruction and automatic retries are forbidden. Do not apply through another
CLI or reuse the renderer module's apply command.

The initial post-apply plan can report parent-resource observations of child
policies/encryption/versioning created in the same apply. The creation guard
continues to reject drift. The separate read-only command
`terraform bootstrap verify --review=review-tw2AvE` checks only those exact
observations against their child resources and requires all actions to be no-ops.
It neither grants apply authority nor persists refreshed state.

## State migration and CI activation are separate

Bootstrap state remains in its own private local backend. The existing renderer
state and backups are never overwritten. After reviewed provisioning, verify
bucket ownership, versioning, KMS/TLS enforcement and actual lock contention.
Then prepare a separately reviewed migration using the emitted backend settings,
an exclusive operation window and a new private backup. Compare state lineage,
serial and resource identities before and after migration. The active renderer
backend must not change until that operation is ready.

Protect Preview, verify issued OIDC claims and review activation before removing
the trust Deny. Keep the Wrangler-only native release stop. Infrastructure and
identity setup do not qualify paired Worker/image release, rollback, cloud fault
testing or production promotion.

## Staged repository trust migration

The activation, creation, state migration and policy operations above are
historical one-shot operations. Preserve their constants, receipts and journals.
They do not authorize retargeting existing roles. The current bootstrap state is
remote. Never reconstruct its lineage or serial from those historical examples.

The separate guarded route is:

```sh
node scripts/aws-personal.mjs terraform bootstrap repository-trust development discover
node scripts/aws-personal.mjs terraform bootstrap repository-trust development plan
node scripts/aws-personal.mjs terraform bootstrap repository-trust development show --review=development-ABC123 --plan-sha256=<saved-hash>
node scripts/aws-personal.mjs terraform bootstrap repository-trust development apply --review=development-ABC123 --plan-sha256=<saved-hash>
```

These examples describe a future reviewed operation. Source preparation does not
execute or approve it. `ABC123` is synthetic. Every AWS request still passes
through the existing exact personal SSO/account/region guard. Authentication or
missing private tools/configuration stops the operation. Do not create substitute
credential files or use a different Terraform/AWS runner.

Development changes only `aws_iam_role.ci`'s exact subject scalar. Its private
render retains the reviewed original Production subject, leaving the old
Production release and paired rollback route available while Development is
qualified. Production uses a later explicit `repository-trust production` plan,
show and apply. It changes only `aws_iam_role.production_ci`; Development must
already use its verified target subject. Neither stage permits dual subjects,
permission changes, new roles, replacement, state movement or output changes.
Production candidate-read resources remain pinned. A fresh candidate may need a
separate narrow permission review after its actual resources are known.

### Protected prerequisites and discovery

The parent provisions existing private tools/configuration from approved sources.
New operation evidence lives under `.data/terraform-video-bootstrap/repository-trust/`
with private directories and exclusive mode-0600 synced evidence files. Required
protected configuration keys have no deployed defaults:

- `trustOriginalRepository` and `trustOriginalReceiptSha256` identify the original
  personal repository and exact `original-repository-receipt.json` bytes. That
  independently reviewed receipt contains `repositoryId`, `subjectPrefix`, the
  original bootstrap `lineage`, `accountId`, `region` and `backendKey`. Obtain it
  from the original approved receipt, never from a guessed slug or new state.
- `trust_development_reviewedCommit` and `trust_production_reviewedCommit` pin the
  clean reviewed checkout to current canonical main. Each stage independently
  requires authoritative main Quality and exact-head Independent review through
  the existing admission verifier.
- `trust_<stage>_baselineSha256` pins the separately reviewed
  `<stage>-baseline.json`. `discover` requires the original receipt and reviewed
  commit, but does not require or manufacture this baseline approval.
- `trust_<stage>_approvedReviewSha256`, `trust_<stage>_approvedPlanSha256` and
  `trust_<stage>_approvedSourceSha256` are supplied only after independent review
  of that exact saved binary, complete JSON, source/guard/test/workflow manifest,
  rendered module, canonical trust delta and fresh state/permission evidence.
  Local hashes detect changes; they do not create an approval or GitHub status.

`discover` is the guarded read-only route for the missing live baseline. It
checks the existing versioned KMS state object and expected owner, privately
renders the fixed nine files, initializes only the existing S3 backend, and saves
fresh complete remote state and IAM/provider/inline/boundary/attachment evidence.
It performs no plan or apply. It also remains available after a started journal
for inspection, retaining that journal's hash. Review its private `discovery.json`
and original receipt before preparing a baseline. No tracked fixture contains
operational values.

The baseline explicitly contains `original`, `sourceCommit`, fresh `observedAt`,
complete `state` and `permissions` from discovery, `proofRuns.development`,
`proofRuns.production`, `parentObservations`, and `window`. The window contains
`observedAt`, `expiresAt`, `exclusive: true`, `admissionsFrozen: true` and the exact
original/target `repositoryIds` in that order. Independently establish a freeze
of release admissions in both repositories for that window. The guard rechecks
all queued, in-progress, waiting, pending and requested runs in both repositories;
concurrency group names alone do not establish exclusion. Unavailable evidence
or uncertain admission control blocks planning/apply.

`parentObservations` is normally empty. Any accepted provider-computed parent
inline-policy observation must enumerate one fixed CI/runtime role `address`,
exact stale `before` list and exact refreshed `after` list. The latter must match
that role's existing separately managed child policy name and canonical document.
The complete refreshed plan must report exactly those observations, with no
other changed field. Unknown drift, unresolved values, attachments or policies
stop. Do not normalize permissions or state to make a plan pass.

### Fresh proofs and the Production prerequisite

First dispatch canonical `native-ci-identity.yml` on the exact reviewed main with
its explicit `proof_only: true` input. Its separate protected Preview `proof` job
verifies signed claims without assuming AWS. The default remains `false`; normal
runs require proof success and retain every prior account, storage, KMS enforcement
and lock-contention check in the dependent `identity` job. A proof-only success
is never storage, release or readiness success. A failed whole run cannot supply
the migration proof. Dispatch fresh canonical Production identity verification
on the same exact main too. It verifies signed claims without AWS assumption.

The migration checks canonical workflow/repository/owner IDs, main protections,
immutable OIDC API prefix, successful whole runs and exact proof job/step,
first attempt, issuer, audience, environment, exact subject and source. It reads
only the bounded verified claim receipt from the canonical job; raw JWTs are
never logged or retained. Proofs, baseline and operation-window observations
expire after 30 minutes and are rechecked immediately before applying.

After Development trust succeeds, run normal identity/storage verification and
the established fresh full Development candidate, qualification and paired
rollback lanes. Identity success alone cannot admit Production. Production
additionally requires the prior `development-started.json` and its confirmed
`complete.json`, pinned by `trust_production_developmentCompleteSha256`.
It requires `development-qualification-receipt.json` from the existing
`verify-qualification` operation and `development-rollback-receipt.json` from
the successful paired rollback. Their byte hashes must match both
`trust_production_qualificationReceiptSha256` / `trust_production_rollbackReceiptSha256`
and the baseline's `developmentReadiness.qualificationReceiptSha256` /
`rollbackReceiptSha256`. Independent review must verify their immutable original
objects, exact fresh pair, cleanup and rollback evidence through the existing
release verifiers. Do not synthesize these receipts from a successful run label.

`developmentReadiness` also supplies `sourceCommit`, `verifiedAt`,
`qualificationRunId`, `rollbackRunId`, `qualified: true` and
`rollbackVerified: true`. The guard requires full verified qualification with
cleanup, exact source/pair and immutable references, a separate successful
rollback of that pair, and fresh successful first-attempt canonical Development
run metadata for both IDs. Missing established evidence blocks Production.
A later main change requires new exact-source proofs, baseline and review.

### Plan, apply and uncertain responses

Each plan privately renders exactly the lockfile, four HCL files, runtime
`tf.json` and three policy JSON files. It records both template and resolved byte
hashes. Only the private copy changes the historical relative provider-config
path to the guard's exact absolute path, pins Terraform 1.12.2, checks locked AWS
provider 6.62.0, adds expected backend owner and stages the unselected Production
subject. The tracked module and historical records remain intact.

Initialization uses existing S3 bucket/key/KMS/account/region, encryption, native
lockfile and default workspace. The guard requires the approved original lineage,
fresh exact serial and complete resource IDs/inventory. It retains full refreshed
saved binary plans with native locking, bounded wait and parallelism one. It
rejects targeting, import, move, replacement, deletion, refresh-off, state push,
force-unlock, changed permissions/provider/identity, unknown drift and outputs.
Apply rechecks source, rendered files, proofs, protections, personal identity,
live trusts/permissions, backend and full state content against the reviewed plan.

Before the one-time saved-plan apply it syncs an exclusive per-stage started
journal and private binary copy. Any response loss or failed postcheck leaves
that journal in place and stops. Never delete it, blindly reapply, replay an
historical operation, push an old state, or reverse a subject ad hoc. Use guarded
`discover` plus fixed IAM reads to establish current evidence. Any completion or
reverse change requires a separate reviewed, source/state/evidence-bound recovery
route; this implementation deliberately exposes no recovery mutation command.

Confirmed apply requires preserved lineage/inventory/IDs/permissions, advanced
serial, exact selected trust, unchanged other role, and a full refreshed no-op
plan. Completion explicitly records that fresh identity/storage qualification
is still required and that release readiness has not been granted. Keep all
private evidence and every original journal. Production deployment remains the
existing guarded paired admission/release/rollback route.

This source change leaves the accepted CodeQL ledger untouched. Its source pin
becomes stale. Before publishing, prepare the final assessment, fresh hosted
analysis and independent final-head/current-base review, plus full Shop
`check:ci` and `test:e2e:local`. Neither this migration nor its fixtures waive those
gates or alter any query.
