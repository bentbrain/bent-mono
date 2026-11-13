# Shop

The storefront deployed at `shop.bent.build` is a Next.js app backed by Cloudflare Workers and an isolated video renderer. The product uses the root Bun workspace and `@forever-tee/*` packages.

| Path | Purpose |
| --- | --- |
| `apps/web` | Storefront, camera/upload creation, editor, cart and order management |
| `workers/api` | Application API, catalogue, artwork preparation, orders and queues |
| `workers/print-executor` | Separate print execution Durable Object namespace |
| `workers/video-renderer` | Renderer and isolated Lambda adapter |
| `packages/contracts` | Shared domain and HTTP contracts |
| `packages/product-image-renderer` | Product image rendering and displacement assets |
| `assets/lifestyle` | Shared renderer inputs |
| `shopify/notifications` | Transactional email templates and their local checks |

Run `bun install --frozen-lockfile` from the monorepo root. Node 24 remains the application and tooling runtime. From this directory:

```sh
bun run shop:dev
bun run dev:api
bun run test:e2e:local
bun run check:ci
```

`check:ci` uses fake service endpoints and explicit fixture values. Worker build and generated-type commands run through `scripts/worker-local-check.mjs`, which permits only local validation operations. Its generated configs live in ignored `.wrangler` directories. Deployment requires the guarded release workflow. The storefront imports `@bent/design-tokens/tokens.css`; shop colour variables alias those tokens.

## Protected deployment configuration

Deployment identity and existing private resource references are supplied through `SHOP_PROTECTED_CONFIG_JSON`. `scripts/protected-config.schema.json` lists the required keys. The accessor requires every requested value and fails closed without configuration. Supply the approved account explicitly through protected configuration.

`{{SHOP:key}}` markers in deployment templates are resolved only from that protected configuration. A trusted release must materialize and seal its exact inputs before cloud tooling runs. Supply only the runtime keys each Worker or Lambda needs. Keep historical operational evidence in private storage. Keep configuration, actual receipts, credentials, `.data`, state and generated deployment files outside git. Synthetic values in `scripts/protected-config.fixtures.json` are test inputs and provide no release approval.

The release scripts retain exact account/repository checks, isolated personal AWS access, cloud-only builds, immutable source/image evidence, browser and native qualification, release drains and paired rollback. Always use `node scripts/aws-personal.mjs` for authorized personal AWS operations. Never use work credentials or another profile when authentication fails.

The reviewed workflow sources live under this product's `.github` directory. From this directory, `bun run release:workflows --write` prepares the eight canonical root release workflows for a PR and refuses to overwrite existing files. Add `--with-operations` to prepare the eight continuing operational and notification workflows alongside them. That explicit preparation verifies any existing copies byte for byte and creates missing files. `bun run release:workflows --check --with-operations` verifies all sixteen canonical copies. Select `--with-schedule` separately after qualification. Dispatch an operation from reviewed main through its protected GitHub environment after admission succeeds.

Reserve the exact protected environment names `Preview` and `Production` for Shop, restrict both to reviewed main, and preserve the unlinked Vercel project with `products/shop/apps/web` as its root. The workflows check the authoritative monorepo quality run at the exact current main before cloud access. Expected repository and owner IDs use `SHOP_REPOSITORY_ID` and `SHOP_OWNER_ID` repository variables; AWS account and role inputs use `SHOP_AWS_ACCOUNT_ID`, `SHOP_AWS_DEVELOPMENT_ROLE_ARN` and `SHOP_AWS_PRODUCTION_ROLE_ARN` environment secrets. Actual caller/account/role/subject and first-attempt checks remain independent of those configured expectations. Configure immutable GitHub OIDC subjects and narrowly reviewed AWS trust separately; the original creation-only bootstrap is not a repository migration tool.

Production identity inspection preserves the existing renderer. It accepts the Cloudflare configuration or validates an existing Lambda Worker with the same native baseline checks used by releases, including the personal function, recorded image/source pair, release identity, secret bindings, queue settings and execution-fence schema. Inspection uses fixed Cloudflare reads and SELECTs, makes no AWS requests and never grants promotion readiness.

Release Playwright reports, raw traces, ZIP attachments and screenshots are preserved together in a streamed encrypted TAR archive, with no pointer-size limit or truncation. Recover a downloaded archive privately with `bun run release:open-browser-artifacts --input CIPHERTEXT --output PRIVATE_TAR --source SOURCE_SHA --run RUN_ID` using the protected versioned key. Authenticate first, inspect the TAR entries, and then extract in private storage. Public release logs contain bounded progress summaries. Full console arguments, Error stacks and binary child stdout/stderr are encrypted synchronously before progress is printed. Every independently authenticated record binds repository, source, run, attempt, job, key version and monotonic sequence. Messages are chunked without truncation; each append is flushed before returning, including diagnostics from failures before cloud evidence is written. Every protected capture job always uploads only its ciphertext diagnostic directory. Qualification pointers, browser acceptance observations, local storefront artifacts and submitted promotion/recovery inputs use authenticated AES-256-GCM encryption. Set `SHOP_EVIDENCE_ENCRYPTION_KEY` to 64 lowercase hex characters representing 32 random bytes and `SHOP_EVIDENCE_KEY_VERSION` to an explicit version such as `v1` in both protected environments and the authorized private local release environment. Retain old keys in the protected `SHOP_EVIDENCE_PREVIOUS_KEYS_JSON` map during rotation; missing, unknown, duplicate or changed keys fail closed. Never put these keys in command arguments, Git, public logs or artifacts.

Download the job-specific `shop-private-diagnostics-RUN-ATTEMPT-JOB` artifact into private storage. Use `bun run release:open-diagnostics --input CIPHERTEXT_DIRECTORY --output PRIVATE_JSONL --source SOURCE_SHA --run RUN_ID --attempt ATTEMPT --job JOB` with the protected versioned key. The command authenticates every session before publishing any plaintext and refuses to run inside GitHub Actions. Original formatted text and safe argument inspection are retained. Serializable arguments also retain Node V8 bytes, including circular references and binary buffers. Interrupted sessions require explicit `--recover-interrupted`; recovery returns exit code 2 and marks the authenticated prefix and any incomplete message. A missing end marker never becomes complete evidence. Invalid terminated records, gaps, reordered records and authentication failures still fail with no published plaintext. Do not print or upload the decoded file publicly.

The coordinator seals private dispatch inputs before contacting GitHub. For a manual dispatch, prepare the ciphertext in a private file with `bun run release:seal-input --field promotion_input --source SOURCE_SHA --input PRIVATE_JSON --output PRIVATE_CIPHERTEXT`; the other supported fields are `qualification_reference`, `renderer_reference` and `rollback_reference`. Submit the ciphertext as the corresponding workflow input. Activated workflows reject plaintext inputs, authenticate the exact source/purpose/original evidence run and decrypt before loading release policy. Admission requires every immutable object, source/build, qualification, browser and owner-acceptance check.

Operational workflows require `expected_source` to match the exact current main commit with successful Quality, native security and merged-PR Independent review evidence. Environment, operation, action and garment color are public selectors. Configured product IDs, reasons, confirmations, revisions, slot selections, command IDs and composition/backup references travel together in `private_input`. Prepare a private JSON object containing the original field names below, then seal it for the exact workflow, environment, operation and source:

```sh
bun run release:seal-input --field private_input --workflow product-lifecycle.yml --environment development --operation transition --source SOURCE_SHA --input PRIVATE_JSON --output PRIVATE_CIPHERTEXT
```

| Workflow | Fields in the private JSON object |
| --- | --- |
| `operations.yml` | `reason`, `configured_product_id` |
| `product-lifecycle.yml` | `configured_product_id`, `expected_state`, `target_state`, `reason`, `confirmation`, `command_id` |
| `featured-products.yml` | `expected_revision`, `command_id`, `slot_1` through `slot_6` |
| `featured-video.yml` | `final_product`, a slot from 1 to 6 or a configured product UUID; use `--operation render` when sealing |
| `featured-composition.yml` | `native_release`, `qualified_source`, `cleanup_source` |
| `backup-renderer.yml` | `recovery_source` |

Optional fields accept empty strings. Submit the ciphertext as `private_input`, with matching public selectors. Printify webhook configuration uses the public `plan` or `apply` selector. Unknown fields, plaintext records, changed source, environment or purpose fail before operational work. The existing owner, workflow identity, one-use intent and recovery checks still govern each operation. After an uncertain response, recover the saved request and reuse its exact command ID or intent.

Receipts, render manifests, media and subprocess diagnostics use the protected encrypted artifact route. Download the operational artifact into private storage, then authenticate its TAR with `bun run release:open-browser-artifacts --workflow WORKFLOW.yml --input CIPHERTEXT --output PRIVATE_TAR --source SOURCE_SHA --run RUN_ID`. Inspect the entries before extracting. Product lifecycle adds the Vercel protection bypass header when `VERCEL_AUTOMATION_BYPASS_SECRET` is configured; storefront invalidation always requires the service secret. An invalidation failure after a committed transition requires recovery with the saved command ID.

The email notification workflow validates and builds the 46 public templates from `shopify/notifications` using pinned Bun and the root `bun.lock`. Its downloadable artifact contains ordinary template data.

Keep `currentProductionImageDigest` and `currentProductionSourceDigest` in protected configuration separate from the historical resource keys. Initially pin them to the inspected existing live pair. After a successful, verified guarded cutover, advance only these two current-pair fields to the recorded new live pair so canary, storefront and recovery operations retain an exact expected identity. Never overwrite historical recovery records or treat changing this expected state as release approval.

The first full Development release requires a fresh candidate. If a separate candidate build is deliberately reused, configure its exact verified receipt through the protected `SHOP_DEVELOPMENT_CANDIDATE_RECEIPT` secret; the loader still reads its original immutable source/object versions and cloud build. A failed or uncertain build/deployment must be inspected and recovered from its journal, never automatically repeated. The first monorepo cutover requires full cloud qualification and fresh source-bound acceptance, including actual alert-email receipt confirmation. Historical repository receipts and synthetic fixtures cannot approve it.

## Isolated renderer image

The Lambda runtime image retains its own frozen `package-lock.json` and `npm ci` installation. Those files are sealed cloud build inputs for its existing Node/native-addon image. Bun manages the monorepo developer workspace; changing this isolated image dependency format requires a separate qualified image change. Source bundles use explicit allowlists and never include developer credentials or customer files.

## Local release controller proof

Run `bun run release:v2:proof --output /absolute/private-proof-directory` to exercise release composition, artifact verification and controller recovery against local HTTP provider fixtures. Use a new private directory outside the checkout. The proof runs the actual controller executable, retains its journal and invocation evidence, and reports its local fixture scope. Reporting recovery uses the saved outbox without staging or activating runtime code.

The customer-journey proof connects that controller to the built Cloudflare storefront, business Worker, isolated D1/R2 and Durable Objects, native image rendering and FFmpeg. Supply the verified local native capsule, a retained business-Worker proof and the storage guard:

```sh
node scripts/release-v2/testing/real-journey-proof.mjs \
  --output /absolute/private/new-run \
  --capsule /absolute/private/native-capsule \
  --prior-proof /absolute/private/business-proof \
  --storage-guard /absolute/path/to/mac-mini-storage
```

Each run verifies artifact and input identities, exercises candidate and active customer journeys, and retains browser, service and controller evidence. Provider staging and activation use local HTTP fixtures.

Controller failures retain the original error and stack in a private `failure-*.json` file beside the journal. Terminal output identifies that file and its checksum. An invalid or unwritable private destination reports that diagnostic capture is unavailable and keeps the operation stopped.

Read `AGENTS.md` and `docs/ui-ux-principles.md` before changing shop behaviour. Keep customer incident records and private acceptance evidence outside this public repository.
