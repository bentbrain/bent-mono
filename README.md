# bent.build

A Bun monorepo for bent.build and its subdomains. The apps share design tokens, React controls and build tooling. Each app owns its routing, authentication, storage and release process.

| Application      | Domains                                                                              | Source                                     |
| ---------------- | ------------------------------------------------------------------------------------ | ------------------------------------------ |
| Website          | [bent.build](https://bent.build), www.bent.build                                     | [apps/www](apps/www/README.md)             |
| Blog             | [jp.bent.build](https://jp.bent.build)                                               | [apps/jp](apps/jp/README.md)               |
| Stay guide       | [stay.bent.build](https://stay.bent.build)                                           | [apps/stay](apps/stay/README.md)           |
| Feedback toolbar | [toolbar.bent.build](https://toolbar.bent.build)                                     | [apps/toolbar](apps/toolbar/README.md)     |
| Collage          | [maya-collage.bent.build](https://maya-collage.bent.build), maya-collages.bent.build | [apps/collage](apps/collage/README.md)     |
| Drive            | [drive.bent.build](https://drive.bent.build), tesla.bent.build                       | [products/drive](products/drive/README.md) |
| Home             | [home.bent.build](https://home.bent.build)                                           | [apps/home](apps/home/README.md)           |
| Trackmap         | [trackmap.bent.build](https://trackmap.bent.build)                                   | [apps/trackmap](apps/trackmap/README.md)   |
| Fitness          | [fitness.bent.build](https://fitness.bent.build)                                     | [apps/fitness](apps/fitness/README.md)     |

`deployments.json` lists the apps and their deployment settings. Drive keeps its internal packages and services under `products/`.

`apps/fitness-ios` is bent Fitness, an Expo iPhone app that sends Apple Health weigh-ins and runs to Fitness. Its README covers setup, the Simulator workflow and its tests.

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

The root `bun.lock` manages workspace dependencies.

CI checks affected workspaces and their consumers, including dependency changes in the root lockfile. Required checks cover lint, types, builds and security. Weekly and manually dispatched Quality runs execute the full regression suite. Root automation changes and incomplete comparison history trigger validation of every workspace.

Quality runs full CodeQL analysis of the JavaScript and TypeScript with both security suites. On pull requests, the merge queue, scheduled runs and dispatch, it runs the native iPhone build and tests when a change reaches the iPhone app, its contracts or the Fitness handlers it calls. On main pushes, Quality leaves that suite to Fitness iOS Verification, which runs it for main pushes that touch the iPhone app, the workspace code it builds against or any file outside the workspaces, and daily. The required `fitness-ios-native` check passes when that suite passes or when the run leaves it out. Merge requires independent review of the exact head against the current base. Production releases have their own qualification checks.

Every Quality job stops within 20 minutes, and the longest chain of dependent jobs, from CI scope through the native iPhone suite to `Release qualification`, stays under 30 minutes. Browser shards stop at 15 minutes.

Fitness iOS Verification (`.github/workflows/fitness-ios-verify.yml`) runs on main pushes that touch the iPhone app, the workspace code it builds and tests against or any file outside the workspaces, daily at 17:00 UTC, and on dispatch. Its five macOS jobs start together and none waits for another: two Swift CodeQL jobs with both security suites, one for the app and one for the Health Seed tool with the Health module's Swift package, and one job for each Simulator flow. The flow jobs also run the native suite: the production build and artifact check beside the denied flow, and SwiftLint, the XCTest suite and the contract round trip beside the allowed flow. The CodeQL jobs and the denied flow stop at 27 minutes, the other flows at 25, and the final `Fitness iOS verification` job at 2, so a run ends within 29 minutes. Each CodeQL job runs with `upload: never` and `upload-database: false`, requires zero raw findings through `scripts/check-sarif.mjs`, and keeps its original SARIF report as a workflow artifact for 90 days. TestFlight releases and Fitness web releases require this workflow to have passed on the exact main commit, so a Swift finding blocks the release. The Swift reports stay in these artifacts and the run's log, and the Security tab lists Quality's CodeQL analysis.

## Trackmap

`bun run dev --filter=@bent/trackmap` starts the activity card editor. Import GPX, TCX, FIT or GeoJSON files from Strava or another GPS recorder. Activity files and background media are processed in the browser. A synthetic sample route is included.

The editor turns recorded coordinates and elevation into a rotating 3D route. Adjust the camera, colour, title, units and route endpoints. Export a 9:16 Story or 1:1 square H.264 MP4 at 1080 px wide with a plain background or a local photo or video. Export a transparent or styled PNG at 1080 px wide, or a looping GIF at 540 px wide. PNG and GIF exports can be used as layers in an editor.

Trackmap uses the shared Vercel release route from `apps/trackmap`, with Node 24, the pinned Bun bootstrap and workspace access. Assigning `trackmap.bent.build` requires the exact-head `Release qualification` production Deployment Check.

## Shared design system

`packages/design-tokens` defines the bent font, cobalt accents, backgrounds, border width and square corners. Import `@bent/design-tokens/tokens.css` and map the tokens to the app's own styles and reset.

`packages/ui` provides shared React controls. Buttons support `primary`, `outline` and `ghost` appearances through the `appearance` prop. App wrappers define their own variants. Import `@bent/ui/field` for labelled fields, inputs and selects, and `@bent/ui/controls.css` for control styles. Validate every consumer when changing a shared package.

## Public source and private data

`SOURCE_PROVENANCE.json` records the audited source snapshots, original repositories and revisions. Each app retains its original license.

Stay loads guide content, photos and home-control configuration from private Blob storage after authorization. Public previews use synthetic fixtures. Production serves content only after a successful private-storage load. Saving requires a production content source and editor authorization.

Home uses protected build configuration for its location, device bindings and private release settings. Example files document the required fields with synthetic values.

Before publishing, run the source policy check and Gitleaks, then review content and binary assets for private information.

## Releases

Each release requires verified source, protected configuration and app-specific qualification. JP checks exact commits, Toolbar retains browser assets, and Home verifies compatibility between its public app and private card.

The website, Stay, Collage, Drive, Trackmap and Fitness use Vercel projects with their app directory as the project root and access to the workspace. Their Vercel configuration pins Bun 1.4.4 for installation and builds. The production Deployment Check requires GitHub's `Release qualification`, which passes after every root Quality job succeeds.

For the website, Stay, Collage, Drive and Trackmap, configure the Ignored Build Step as `node "$(git rev-parse --show-toplevel)/scripts/vercel-ignore-build.mjs" --app <name>`, using `www`, `stay`, `collage`, `drive` or `trackmap`. Application and shared-package changes request builds. Root dependency and build configuration changes also request builds. Unrelated application, documentation and release-check changes skip application builds. Missing Git history requests a build. Keep native affected-project skipping enabled. Skipped builds still consume deployment quota and concurrent build slots.

Use `bun run release:vercel inspect|stage|promote --app <name> --config <protected-file>` for these applications. Inspection and promotion also require `--deployment <id>`. Staging and promotion require a new `--journal <private-file>`; promotion additionally requires `--qualification <private-file>`. The protected configuration supplies `teamId`, `projectId`, `expectedProductionId` and `requiredCheckId`. Set scoped `VERCEL_TOKEN` and `VERCEL_ORG_ID` credentials through the existing protected operator environment. Keep these files, credentials and journals outside public source.

For a new project, set `firstRelease: true` and `expectedProductionId: null` in the protected configuration. Staging requires an empty production deployment history. Promotion requires that only the qualified candidate exists and that production remains unassigned. After promotion, record its deployment ID as `expectedProductionId` and remove `firstRelease` for subsequent releases.

Stage the first production build with manual domain assignment. Before staging or promotion, the shared command verifies current main, the entire latest Quality run, and the merged PR's native security and independent review. For `--app fitness`, it also requires the latest Fitness iOS Verification run for that commit to have passed every job. Verification runs on its own for main pushes that reach the iPhone app or its dependencies. For another commit, dispatch Fitness iOS Verification on `main` and wait for it to pass before staging or promoting. A runtime qualification receipt records the app, deployment ID, source revision, timestamp, inspected configuration hash, `runtimeQualified: true` and passing `checks`. Stay requires host access to the guide, photos and editor, guest access to the guide and photos, and host-only editor access. Other Vercel apps require `applicationSmoke`. The operator records these results after testing the exact deployment.

Manual promotion checks GitHub's authoritative results directly. Vercel's imported GitHub check starts with automatic domain assignment, so staging can precede its native run. The command preserves the native check definition and rejects unsuccessful, ambiguous or unknown blocking results. Every other blocking check requires a successful result. After an accepted request, verify the deployment, canonical domains, protections and automatic-assignment setting. An uncertain request keeps its one-use journal for inspection before further action. With automatic assignment enabled, subsequent Git releases use Vercel's native GitHub-check gate.

`scripts/vercel-bun.mjs` uses Node.js 24 to download the exact root `packageManager` into a temporary directory. It fetches Bun through npm with lifecycle scripts disabled, initializes Bun's native wrapper, verifies the version, then runs the app's frozen install or build. Application dependencies use Bun, the root lockfile and the workspace's lifecycle policy.

JP and Toolbar use root deployment workflows controlled by `JP_DEPLOYMENT_ENABLED` and `TOOLBAR_DEPLOYMENT_ENABLED`. Credentials belong in the `jp-production` and `toolbar-production` protected environments. Both routes verify current main, the complete Quality run, and the merged PR's exact-head security and independent review. JP preserves its Worker secrets and requires an up-to-date database schema. Toolbar publishes and verifies retained frontend assets before activating its Worker.

Home uses `bun run release:both` from `apps/home`, with its location, device bindings and private release settings in protected configuration. The paired release checks the exact public source revision before advancing the private card.

Release from a clean, committed tree after its checks pass. Review evidence belongs to its exact revision. Preserve existing private content during setup, and run production migrations through their reviewed release procedure.
