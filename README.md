# bent.build

A Bun monorepo for bent.build and its subdomains. The apps share design tokens, React controls and build tooling. Each app owns its routing, authentication, storage and release process.

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

`deployments.json` lists the apps and their deployment settings. Shop and Drive keep their internal packages and services under `products/`.

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

Run app commands from their directories or use Bun workspace filters. Each app's example environment file describes its configuration. Store credentials and production content in the app's protected environment and storage.

The root `bun.lock` manages workspace dependencies. The AWS Lambda renderer image uses its own frozen npm lock as a production image input. Changes to that image's installer require renderer qualification.

CI checks affected workspaces and their consumers, including dependency changes in the root lockfile. Required checks cover lint, types, builds and security. Shop also runs web unit tests, cart and purchase-readiness contracts, renderer tests and a mobile upload-to-cart browser smoke test with synthetic fixtures. Weekly and manually dispatched Quality runs execute the full regression suite. Root automation changes and incomplete comparison history trigger validation of every workspace.

Every CI run includes full CodeQL analysis. Code outside Shop requires zero raw findings. Shop's intentional network and file transfers have individual review records bound to their source, guards, tests and complete analysis traces. The gate rejects unknown findings and stale records, and retains the original report. Independent review of the exact head and current base is required before merge or a native false-positive dismissal. Production releases have their own qualification checks.

## Trackmap

`bun run dev --filter=@bent/trackmap` starts the activity card editor. Import GPX, TCX, FIT or GeoJSON files from Strava or another GPS recorder. Activity files and background media are processed in the browser. A synthetic sample route is included.

The editor turns recorded coordinates and elevation into a rotating 3D route. Adjust the camera, colour, title, units and route endpoints. Export an H.264 Story MP4 at 1080 px wide over a local photo or video, a transparent or styled PNG at 1080 px wide, or a looping GIF at 540 px wide. MP4 combines the animation and background for Instagram uploads. PNG and GIF exports can be used as layers in an editor.

Trackmap uses the shared Vercel release route from `apps/trackmap`, with Node 24, the pinned Bun bootstrap and workspace access. Assigning `trackmap.bent.build` requires the exact-head `Release qualification` production Deployment Check.

## Shared design system

`packages/design-tokens` defines the bent font, cobalt accents, backgrounds, border width and square corners. Import `@bent/design-tokens/tokens.css` and map the tokens to the app's own styles and reset.

`packages/ui` provides shared React controls. Buttons support `primary`, `outline` and `ghost` appearances through the `appearance` prop. App wrappers define their own variants. Import `@bent/ui/field` for labelled fields, inputs and selects, and `@bent/ui/controls.css` for control styles. Validate every consumer when changing a shared package.

## Public source and private data

`SOURCE_PROVENANCE.json` records the audited source snapshots, original repositories and revisions. Each app retains its original license.

Stay loads guide content, photos and home-control configuration from private Blob storage after authorization. Public previews use synthetic fixtures. Production serves content only after a successful private-storage load. Saving requires a production content source and editor authorization.

Home uses protected build configuration for its location, device bindings and private release settings. Shop uses protected configuration for account identities, release records and infrastructure bindings. Example files document the required fields with synthetic values.

Before publishing, run the source policy check and Gitleaks, then review content and binary assets for private information.

## Releases

Each release requires verified source, protected configuration and app-specific qualification. Shop uses paired releases, JP checks exact commits, Toolbar retains browser assets, and Home verifies compatibility between its public app and private card.

The website, Stay, Collage, Drive and Trackmap use Vercel projects with their app directory as the project root and access to the workspace. Their Vercel configuration pins Bun 1.4.4 for installation and builds. The production Deployment Check requires GitHub's `Release qualification`, which passes after every root Quality job succeeds.

Use `bun run release:vercel inspect|stage|promote --app <name> --config <protected-file>` for these applications. Inspection and promotion also require `--deployment <id>`. Staging and promotion require a new `--journal <private-file>`; promotion additionally requires `--qualification <private-file>`. The protected configuration supplies `teamId`, `projectId`, `expectedProductionId` and `requiredCheckId`. Set scoped `VERCEL_TOKEN` and `VERCEL_ORG_ID` credentials through the existing protected operator environment. Keep these files, credentials and journals outside public source.

Stage the first production build with manual domain assignment. Before staging or promotion, the shared command verifies current main, the entire latest Quality run, and the merged PR's native security and independent review. A runtime qualification receipt records the app, deployment ID, source revision, timestamp, inspected configuration hash, `runtimeQualified: true` and passing `checks`. Stay requires host access to the guide, photos and editor, guest access to the guide and photos, and host-only editor access. Other Vercel apps require `applicationSmoke`. The operator records these results after testing the exact deployment.

Manual promotion checks GitHub's authoritative results directly. Vercel's imported GitHub check starts with automatic domain assignment, so staging can precede its native run. The command preserves the native check definition and rejects unsuccessful, ambiguous or unknown blocking results. Every other blocking check requires a successful result. After an accepted request, verify the deployment, canonical domains, protections and automatic-assignment setting. An uncertain request keeps its one-use journal for inspection before further action. With automatic assignment enabled, subsequent Git releases use Vercel's native GitHub-check gate.

`scripts/vercel-bun.mjs` uses Node.js 24 to download the exact root `packageManager` into a temporary directory. It fetches Bun through npm with lifecycle scripts disabled, initializes Bun's native wrapper, verifies the version, then runs the app's frozen install or build. Application dependencies use Bun, the root lockfile and the workspace's lifecycle policy.

JP and Toolbar use root deployment workflows controlled by `JP_DEPLOYMENT_ENABLED` and `TOOLBAR_DEPLOYMENT_ENABLED`. Credentials belong in the `jp-production` and `toolbar-production` protected environments. Both routes verify current main, the complete Quality run, and the merged PR's exact-head security and independent review. JP preserves its Worker secrets and requires an up-to-date database schema. Toolbar publishes and verifies retained frontend assets before activating its Worker.

Home uses `bun run release:both` from `apps/home`, with its location, device bindings and private release settings in protected configuration. The paired release checks the exact public source revision before advancing the private card. Shop uses protected `Preview` and `Production` environments, immutable artifacts and full release qualification. Its workflow templates are activated through the product's deployment tooling.

Release from a clean, committed tree after its checks pass. Review evidence belongs to its exact revision. Preserve existing private content during setup, and run production migrations through their reviewed release procedure.
