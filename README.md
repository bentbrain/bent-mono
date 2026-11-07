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
| Trackmap | trackmap.bent.build | apps/trackmap |

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

Routine CI checks affected workspaces and their transitive consumers, including dependency changes resolved from the root lockfile. Lint, typecheck, build and security checks remain required. Shop runs its web unit tests, core cart/readiness/contract and renderer tests, and one fixture-only mobile upload-to-cart browser smoke test. Weekly and manually dispatched Quality runs retain the full regression suite; protected release qualification is unchanged. Unknown comparison history or root automation changes widen validation to all workspaces.

CI always runs full CodeQL analysis. The blog retains its zero-finding requirement. Shop's intentional network/file transfers and fixed-origin requests require individually documented, source-pinned dispositions; unknown findings and stale records fail. Raw analysis remains available. Dispositions require independent review of the exact head and current base before any native false-positive dismissal or merge; they never authorize a production release.

## Trackmap

`bun run dev --filter=@bent/trackmap` starts the local activity card editor. Import GPX, TCX, FIT or GeoJSON files exported from Strava or another GPS recorder. Activity and optional background-photo processing stay in the browser. The sample route is synthetic.

The editor projects recorded coordinates and elevation into a rotating 3D route, with camera, colour, title, units and end-trimming controls. Export a finished, silent H.264 Story MP4 at 1080 px wide over a local photo or video, a transparent or styled PNG at 1080 px wide, or a looping GIF at 540 px wide. MP4 combines the animation and background for uploading to Instagram; GIF and PNG remain available as layers for an editor. Movable animated stickers inside Instagram require GIPHY publishing and moderation, which this application does not perform. There is no Strava account connection or server-side activity storage.

Trackmap uses the ordinary guarded Vercel release route. Its application root is `apps/trackmap`, Node is 24, and the source-owned Vercel config uses the shared pinned Bun bootstrap. Provision the project with workspace access and require the exact-head `Release qualification` production Deployment Check before assigning `trackmap.bent.build`. Do not treat an app build or merged PR as production qualification.

## Shared design system

`packages/design-tokens` defines the bent font, cobalt accents, backgrounds, border width and square corners. Import `@bent/design-tokens/tokens.css` and map the tokens to application styles without importing another application's global reset.

`packages/ui` owns shared React control behavior. Application wrappers retain their existing variants while adopting common primitives. Shared buttons offer optional `primary`, `outline` and `ghost` appearances through the `appearance` prop, without changing application wrapper variants. Import `@bent/ui/field` for labelled fields, inputs and selects, and `@bent/ui/controls.css` for token-based control styles. Keep routing, authentication and product-specific behavior in their applications. Validate all consumers when changing shared packages.

## Public source and private data

Imports are audited source snapshots. `SOURCE_PROVENANCE.json` records their original repositories and revisions; private Git histories remain upstream. Original per-application licenses are retained.

The stay guide loads household content, photos and home-control configuration from private Blob storage after authorization. Its public preview fixture is synthetic and cannot be saved to production. Production fails closed if private content cannot be loaded.

Home location, device bindings and private release configuration belong in protected build configuration. Shop account identities, release records and infrastructure bindings also use protected configuration. Safe examples describe the required shape without supplying production values.

Run the source policy check and Gitleaks before publishing. These checks complement review of private content and binary assets; a successful build alone does not establish that source is safe to publish.

## Releases

Repository migration and production cutover are separate verified steps. Existing production domains continue serving their current releases until each migrated application passes its checks and its protected configuration is verified. Keep the existing shop paired-release protocol, blog exact-commit checks, toolbar asset retention and home public/card compatibility gates.

The website, Stay, Collage, Drive and Trackmap use their existing Vercel projects, with the application directory as the project root and access to workspace files outside that directory. Their source-owned Vercel configuration pins Bun 1.4.4 for installation and builds. Production Deployment Checks require the GitHub `Release qualification` check, which succeeds only after every root Quality job succeeds.

Use `bun run release:vercel inspect|stage|promote --app <name> --config <protected-file>` for these applications. Inspection and promotion also require `--deployment <id>`. Staging and promotion require a new `--journal <private-file>`; promotion additionally requires `--qualification <private-file>`. The protected configuration supplies `teamId`, `projectId`, `expectedProductionId` and `requiredCheckId`. Set scoped `VERCEL_TOKEN` and `VERCEL_ORG_ID` credentials through the existing protected operator environment. Keep these files, credentials and journals outside public source.

Stage the first production build with automatic domain assignment disabled. The shared release command verifies current main, the entire latest Quality run, and the merged PR's native security and independent review before either build creation or promotion. Runtime qualification records the app, deployment ID, source revision, timestamp, inspected configuration hash, `runtimeQualified: true` and passing `checks`. Stay requires host guide/photos/editor access and guest guide/photos access with editor denial; other Vercel applications require `applicationSmoke`. The receipt is an operator record of actual verification, never a generated substitute for running it.

Manual staged promotion validates GitHub directly because Vercel's imported GitHub check requires automatic domain assignment and may have no run during staging. The command preserves the native check definition, refuses any existing unsuccessful or ambiguous blocking result, and never writes a check status. Other missing blocking checks also stop release. A successful API acknowledgement is only an accepted request: verify the actual deployment, canonical domains, protections and automatic-assignment setting before reporting production success. An uncertain request retains its one-use journal and must be inspected before further action. Once automatic assignment is enabled, subsequent Git production releases use Vercel's native GitHub-check gate.

`scripts/vercel-bun.mjs` uses Node.js 24 to bootstrap the exact root `packageManager` in a disposable directory. It downloads Bun through npm with lifecycle scripts disabled, explicitly initialises only Bun's native wrapper, then verifies its version before running the application's frozen install or build. This avoids `bunx` silently launching an uninitialised placeholder when inherited install policy skips the wrapper's postinstall. Application dependencies still use Bun and the root lockfile, with their existing lifecycle policy.

JP and Toolbar have separate root deployment workflows, disabled until their repository variables `JP_DEPLOYMENT_ENABLED` and `TOOLBAR_DEPLOYMENT_ENABLED` are enabled. Credentials belong in their respective `jp-production` and `toolbar-production` protected environments. These routes verify current main, the complete authoritative Quality run, and the merged PR's exact-head security and independent review evidence. JP preserves its provisioned Worker secrets and refuses pending migrations on this migration-only route. Toolbar publishes and verifies retained frontend assets before activating its Worker.

Home retains its operator-driven `bun run release:both` route from `apps/home`. Configure its protected location and private release settings outside this repository. The public build excludes private device bindings; the paired release checks the exact public source revision before advancing the private card. Shop retains its protected `Preview` and `Production` release environments, immutable artifacts and full qualification requirements. Its archived workflow templates require deliberate activation through the product's deployment tooling.

Never deploy from an uncommitted tree, bypass checks, copy a review status to another revision, overwrite private content during setup, or run production migrations as part of a dependency install.
