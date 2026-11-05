# bent.build

Public Bun monorepo for the applications deployed to bent.build and its subdomains. Each application keeps its own runtime, authorization, storage and release process. Emoji applications and unrelated projects are excluded.

| Application | Domains | Source |
| --- | --- | --- |
| Website | bent.build, www.bent.build | apps/www |
| Blog | jp.bent.build | apps/jp |
| Stay guide | stay.bent.build | apps/stay |
| Shop | shop.bent.build | products/shop/apps/web |
| Feedback toolbar | toolbar.bent.build | apps/toolbar |
| Collage | maya-collage.bent.build, maya-collages.bent.build | apps/collage |
| Drive | drive.bent.build, tesla.bent.build | products/drive/apps/web |
| Home | home.bent.build | apps/home |

`deployments.json` records the application boundaries. The shop and drive products retain their existing internal packages and services under `products/` so the migration preserves their release and runtime boundaries.

## Development

Use Node.js 24 and Bun 1.4.4.

```sh
bun install --frozen-lockfile
bun run dev --filter=bent-build
bun run dev --filter=japan-blog
bun run dev --filter=@bent/stay
bun run check:source
bun run test:workspace
```

Run application commands from their directories, or use Bun workspace filters. Configure only the application you are developing using its safe example environment file. Private production content and credentials are never part of this repository.

The root `bun.lock` manages the workspace dependencies. The isolated AWS Lambda renderer image retains its existing frozen npm lock as a production image input; changing that image's dependency installer requires separate renderer qualification. Development and application workspace commands use Bun.

CI runs the existing application checks and full CodeQL analysis. The blog retains its zero-finding requirement. Shop's intentional network/file transfers and fixed-origin requests require individually documented, source-pinned dispositions; unknown findings and stale records fail. Raw analysis remains available. Dispositions require independent review of the exact head and current base before any native false-positive dismissal or merge; they never authorize a production release.

## Shared design system

`packages/design-tokens` defines the bent font, cobalt accents, backgrounds, border width and square corners. Import `@bent/design-tokens/tokens.css` and map the tokens to application styles without importing another application's global reset.

`packages/ui` owns shared React control behavior. Application wrappers retain their existing variants while adopting common primitives. Keep routing, authentication and product-specific behavior in their applications. Validate all consumers when changing shared packages.

## Public source and private data

Imports are audited source snapshots. `SOURCE_PROVENANCE.json` records their original repositories and revisions; private Git histories remain upstream. Original per-application licenses are retained.

The stay guide loads household content, photos and home-control configuration from private Blob storage after authorization. Its public preview fixture is synthetic and cannot be saved to production. Production fails closed if private content cannot be loaded.

Home location, device bindings and private release configuration belong in protected build configuration. Shop account identities, release records and infrastructure bindings also use protected configuration. Safe examples describe the required shape without supplying production values.

Run the source policy check and Gitleaks before publishing. These checks complement review of private content and binary assets; a successful build alone does not establish that source is safe to publish.

## Releases

Repository migration and production cutover are separate verified steps. Existing production domains continue serving their current releases until each migrated application passes its checks and its protected configuration is verified. Keep the existing shop paired-release protocol, blog exact-commit checks, toolbar asset retention and home public/card compatibility gates.

The website, Stay, Collage and Drive use their existing Vercel projects, with the application directory as the project root and access to workspace files outside that directory. Their source-owned Vercel configuration pins Bun 1.4.4 for installation and builds. Production Deployment Checks require the GitHub `Release qualification` check, which succeeds only after every root Quality job succeeds. Stage and verify the first production build before enabling automatic domain assignment.

JP and Toolbar have separate root deployment workflows, disabled until their repository variables `JP_DEPLOYMENT_ENABLED` and `TOOLBAR_DEPLOYMENT_ENABLED` are enabled. Credentials belong in their respective `jp-production` and `toolbar-production` protected environments. These routes verify current main, the complete authoritative Quality run, and the merged PR's exact-head security and independent review evidence. JP preserves its provisioned Worker secrets and refuses pending migrations on this migration-only route. Toolbar publishes and verifies retained frontend assets before activating its Worker.

Home retains its operator-driven `bun run release:both` route from `apps/home`. Configure its protected location and private release settings outside this repository. The public build excludes private device bindings; the paired release checks the exact public source revision before advancing the private card. Shop retains its protected `Preview` and `Production` release environments, immutable artifacts and full qualification requirements. Its archived workflow templates require deliberate activation through the product's deployment tooling.

Never deploy from an uncommitted tree, bypass checks, copy a review status to another revision, overwrite private content during setup, or run production migrations as part of a dependency install.
