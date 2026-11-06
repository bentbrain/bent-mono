# Shop

The storefront deployed at `shop.bent.build` is a Next.js app backed by Cloudflare Workers and an isolated video renderer. This product lives in the parent Bun workspace. Its existing `@forever-tee/*` package names remain stable.

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

`check:ci` uses fake service endpoints and explicit fixture values. Worker build and generated-type commands run through `scripts/worker-local-check.mjs`, which permits only local validation operations. Its generated configs live in ignored `.wrangler` directories. These artifacts cannot authorize deployment. The storefront imports `@bent/design-tokens/tokens.css`; existing shop colour variables alias those tokens without changing the design.

## Protected deployment configuration

Deployment identity and existing private resource references are supplied through `SHOP_PROTECTED_CONFIG_JSON`. `scripts/protected-config.schema.json` lists the required keys. The accessor requires every requested value and fails closed without configuration. No real account or default credential chain is selected automatically.

`{{SHOP:key}}` markers in deployment templates are resolved only from that protected configuration. A trusted release must materialize and seal its exact inputs before cloud tooling runs. Supply only the runtime keys each Worker or Lambda needs, rather than copying historical operational evidence into application environments. Keep configuration, actual receipts, credentials, `.data`, state and generated deployment files outside git. Synthetic values in `scripts/protected-config.fixtures.json` are test inputs and provide no release approval.

The release scripts retain exact account/repository checks, isolated personal AWS access, cloud-only builds, immutable source/image evidence, browser and native qualification, release drains and paired rollback. Always use `node scripts/aws-personal.mjs` for authorized personal AWS operations. Never use work credentials or another profile when authentication fails.

The reviewed workflow sources live under this product's `.github` directory. From this directory, `bun run release:workflows --write` prepares the eight canonical root workflow files for a PR, refusing to overwrite existing files. `bun run release:workflows --check` checks that active files match those sources. The weekly qualification schedule is excluded unless explicitly selected with `--with-schedule` after the new release path is qualified. Historical recovery and benchmark workflows remain inactive. Moving these files never dispatches a release.

Reserve the exact protected environment names `Preview` and `Production` for Shop, restrict both to reviewed main, and preserve the unlinked Vercel project with `products/shop/apps/web` as its root. The workflows check the authoritative monorepo quality run at the exact current main before cloud access. Expected repository and owner IDs use `SHOP_REPOSITORY_ID` and `SHOP_OWNER_ID` repository variables; AWS account and role inputs use `SHOP_AWS_ACCOUNT_ID`, `SHOP_AWS_DEVELOPMENT_ROLE_ARN` and `SHOP_AWS_PRODUCTION_ROLE_ARN` environment secrets. Actual caller/account/role/subject and first-attempt checks remain independent of those configured expectations. Configure immutable GitHub OIDC subjects and narrowly reviewed AWS trust separately; the original creation-only bootstrap is not a repository migration tool.

Production identity inspection preserves the existing renderer. It accepts the Cloudflare configuration or validates an existing Lambda Worker with the same native baseline checks used by releases, including the personal function, recorded image/source pair, release identity, secret bindings, queue settings and execution-fence schema. Inspection uses fixed Cloudflare reads and SELECTs, makes no AWS requests and never grants promotion readiness.

Release Playwright reports, raw traces, ZIP attachments and screenshots are preserved together in a streamed encrypted TAR archive, with no pointer-size limit or truncation. Recover a downloaded archive privately with `bun run release:open-browser-artifacts --input CIPHERTEXT --output PRIVATE_TAR --source SOURCE_SHA --run RUN_ID` using the protected versioned key. Authenticate first, inspect the TAR entries, and then extract in private storage. Public release logs contain bounded progress summaries. Full console arguments, Error stacks and binary child stdout/stderr are encrypted synchronously before progress is printed. Every independently authenticated record binds repository, source, run, attempt, job, key version and monotonic sequence. Messages are chunked without truncation; each append is flushed before returning, including diagnostics from failures before cloud evidence is written. Every protected capture job always uploads only its ciphertext diagnostic directory. Qualification pointers, browser acceptance observations, local storefront artifacts and submitted promotion/recovery inputs use authenticated AES-256-GCM encryption. Set `SHOP_EVIDENCE_ENCRYPTION_KEY` to 64 lowercase hex characters representing 32 random bytes and `SHOP_EVIDENCE_KEY_VERSION` to an explicit version such as `v1` in both protected environments and the authorized private local release environment. Retain old keys in the protected `SHOP_EVIDENCE_PREVIOUS_KEYS_JSON` map during rotation; missing, unknown, duplicate or changed keys fail closed. Never put these keys in command arguments, Git, public logs or artifacts.

Download the job-specific `shop-private-diagnostics-RUN-ATTEMPT-JOB` artifact into private storage. Use `bun run release:open-diagnostics --input CIPHERTEXT_DIRECTORY --output PRIVATE_JSONL --source SOURCE_SHA --run RUN_ID --attempt ATTEMPT --job JOB` with the protected versioned key. The command authenticates every session before publishing any plaintext and refuses to run inside GitHub Actions. Original formatted text and safe argument inspection are retained. Serializable arguments also retain Node V8 bytes, including circular references and binary buffers. Interrupted sessions require explicit `--recover-interrupted`; recovery returns exit code 2 and marks the authenticated prefix and any incomplete message. A missing end marker never becomes complete evidence. Invalid terminated records, gaps, reordered records and authentication failures still fail with no published plaintext. Do not print or upload the decoded file publicly.

The coordinator seals private dispatch inputs before contacting GitHub. For a manual dispatch, prepare the ciphertext in a private file with `bun run release:seal-input --field promotion_input --source SOURCE_SHA --input PRIVATE_JSON --output PRIVATE_CIPHERTEXT`; the other supported fields are `qualification_reference`, `renderer_reference` and `rollback_reference`. Submit the ciphertext as the corresponding workflow input. Activated workflows reject plaintext inputs, authenticate the exact source/purpose/original evidence run and decrypt before loading release policy. Receipt transport does not grant admission: every immutable object, source/build, qualification, browser and owner-acceptance check still runs.

Keep `currentProductionImageDigest` and `currentProductionSourceDigest` in protected configuration separate from the historical resource keys. Initially pin them to the inspected existing live pair. After a successful, verified guarded cutover, advance only these two current-pair fields to the recorded new live pair so canary, storefront and recovery operations retain an exact expected identity. Never overwrite historical recovery records or treat changing this expected state as release approval.

A first full Development release builds a fresh candidate rather than treating the historical committed candidate as current. If a separate candidate build is deliberately reused, configure its exact verified receipt through the protected `SHOP_DEVELOPMENT_CANDIDATE_RECEIPT` secret; the loader still reads its original immutable source/object versions and cloud build. A failed or uncertain build/deployment must be inspected and recovered from its journal, never automatically repeated. The first monorepo cutover requires full cloud qualification and fresh source-bound acceptance, including actual alert-email receipt confirmation. Historical repository receipts and synthetic fixtures cannot approve it.

## Isolated renderer image

The Lambda runtime image retains its own frozen `package-lock.json` and `npm ci` installation. Those files are sealed cloud build inputs for its existing Node/native-addon image. Bun manages the monorepo developer workspace; changing this isolated image dependency format requires a separate qualified image change. Source bundles use explicit allowlists and never include developer credentials or customer files.

Read `AGENTS.md` and `docs/ui-ux-principles.md` before changing shop behaviour. The historical customer incident records and private acceptance evidence remain outside this public source snapshot.
