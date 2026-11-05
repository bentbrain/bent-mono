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

Source consolidation does not activate a production cutover. The workflow definitions under this product's `.github` directory are retained release references. They require repository identity, protected environments, scoped OIDC trust, secrets, root paths and hosting configuration to be migrated before activation. The first monorepo release requires full qualification; historical repository receipts cannot approve it.

## Isolated renderer image

The Lambda runtime image retains its own frozen `package-lock.json` and `npm ci` installation. Those files are sealed cloud build inputs for its existing Node/native-addon image. Bun manages the monorepo developer workspace; changing this isolated image dependency format requires a separate qualified image change. Source bundles use explicit allowlists and never include developer credentials or customer files.

Read `AGENTS.md` and `docs/ui-ux-principles.md` before changing shop behaviour. The historical customer incident records and private acceptance evidence remain outside this public source snapshot.
