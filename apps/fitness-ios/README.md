# bent Fitness

An iPhone app that sends Apple Health weigh-ins and running workouts to [Fitness](../fitness/README.md). It reads Health data, sends it to `POST /api/health/import` with an import-only device key, and shows what each sync did. Viewing and editing stay in Fitness on the web.

- The first sync sends your chosen history while the app is open.
- New weigh-ins and runs sync in the background whenever iOS wakes the app. iOS decides when that happens.
- Each time the app comes to the foreground, it catches up.

## How it works

1. **Sign in.** The app opens Clerk's sign-in in a private browser session with PKCE (S256), a random `state`, the variant's redirect URI, scopes `fitness:health:enroll openid` and `resource` set to the Fitness MCP endpoint. It exchanges the code for an access token and keeps it in memory for one request.
2. **Connect.** `POST /api/health/devices` exchanges that token for a device key. The key is stored in the Keychain (`AfterFirstUnlockThisDeviceOnly`) in a waiting state; nothing is read from Health or sent yet. Each attempt sends `enrollmentSequence`, one higher than the last attempt from this installation. The count is stored in the Keychain before the request goes out, so it keeps rising across relaunches and lost replies. Of the successful replies, the app keeps the key with the highest sequence, whatever order the replies arrive in; a success from a lower sequence is revoked, and a failed attempt leaves the stored key in place. A sign-in begins one enrollment attempt before it opens Clerk, and each of its requests, retries included, passes that attempt. A disconnect or a declined consent cancels the attempt: a request that has not been sent stops without sending, a failure that arrives afterwards ends the sign-in instead of being retried, and a success that arrives afterwards is revoked. Busy and unavailable replies, and `409 stale_enrollment`, are retried with the same token and a new sequence after exactly `Retry-After`; if the token would expire first, the app asks to sign in again later. Replies that use up the token ask for a fresh sign-in, and each refusal has its own message.
3. **Consent.** The consent screen shows the account email, the data types, the destination, when syncs happen, what Disconnect does and how much history to send. Confirming or cancelling names the enrollment the screen shows, so it never acts on a key for another account that replaced it in the meantime; the app then asks to check the screen again. Confirming activates the key with an absolute start date. Cancelling revokes the key. Nothing registers for Health updates while consent is pending.
4. **Health access.** iOS asks which types the app can read: Weight, Workouts and Walking + Running Distance. The app then shows the earliest weigh-in and run it can read since the start date, or that it can read none, and, on iOS 27 when the user shared limited history, the earliest date Health allows. The first sync starts only from this step's Start button; the app stores that it is waiting, so a relaunch comes back here and nothing syncs before it.
5. **First sync (backfill).** The app records where each type's history ends, then sends whole days in the account timezone in order, with `expectedTimezone`. A request gathers whole days up to about 200 samples; a day with more goes on its own, in chunks of up to 2,000 samples, Fitness's limit per request. Days are built with a calendar in the account timezone, and every boundary is the start of its own day, so a daylight-saving change at midnight or at 23:00 drops no hour. It marks a day done only after every request for it succeeds. If the account timezone changes, it regroups from the start date. Changing the history to send rebuilds the recorded positions from the new start date and stops a backfill in progress, so a later start date leaves out history the earlier one covered, deferred samples included. When it reaches today, incremental sync takes over from the recorded position.
6. **Incremental sync.** Each page of up to 200 new samples is one request, and its position is saved only after Fitness accepts it with one outcome per sample. HealthKit observer queries and background delivery wake the app for new data; each run takes background time before it starts and completes HealthKit's handlers exactly once. When that time runs out, the run's writes close: a checkpoint write in progress finishes first, and none starts after. Each checkpoint write runs together with its session check on the device lifecycle, so a history change or a disconnect either stops it or waits for it and then rebuilds or clears what it wrote.

Samples dated after now wait until they are due. A run without a distance waits 6 hours for one. After that it is sent without one, and Fitness saves it as 0 km, only when Health reports that the app can read distance from a date at or before the run's start. Health does not say whether read access was denied, and a readable distance from another time says nothing about this run. On iOS 27, `getEarliestAuthorizedSampleDate(for:)` reports that date when the user shared limited history. With full access, before iOS 27, in a build made with an SDK that lacks the lookup (Xcode 26), when the lookup fails, or when its answer leaves distance out, the app can't tell a run with no recorded distance from one whose distance it can't read. Those runs wait. The status screen shows how many are waiting for distance access, with one button to send them without a distance. The button names the runs the screen showed and the current enrollment. The app approves them only if that enrollment is still active and exactly those runs are still waiting. If a sync added or removed a run in the meantime, nothing is sent, and the screen shows the new count for another tap. A run that starts waiting later needs its own choice. A run whose distance could not be read is never sent as 0 km. The distance comes from the workout's statistics, then its associated distance samples, then its total distance.

The app keeps sample UUIDs, positions and per-run counts in `Application Support/sync/<account>/state.json`. Its directories are excluded from backups before the first write, and each write replaces the file atomically with protection until first unlock already applied. Before the first unlock after a restart, the Keychain and state stay as they are and the app tries again once the iPhone is unlocked; a file holding no Health data or key records whether sync is on, so observers register at launch. It keeps no Health values. Disconnect stops using the key and clears that file first, then stops the current run and the observers, then revokes the key with `DELETE /api/health/devices/current`, retrying on later launches if the iPhone is offline and waiting for `Retry-After`, counted from the reply, when Fitness asks. A key Fitness will not revoke because it is not a device key is counted, and the sign-in, reconnect and status screens show a notice to revoke it under Manage account → API keys until it is dismissed; the count outlives the disconnect. Dismissing names the count the notice showed, so a key refused after the notice appeared stays on it, and it changes nothing about the key or a sync in progress. If an upload gets `401 key_invalid`, the app clears that key, if it is still the stored one, and asks to connect again. This also recovers when a later connection replaced the key on the server but its reply was lost. Logs carry codes and counts only, and the app has no analytics.

## Variants

| Variant | Bundle ID | Redirect URI | Fitness origin |
| --- | --- | --- | --- |
| `development` | `build.bent.fitness.dev` | `build.bent.fitness.dev://oauth` | `https://fitness.bent.build`, or `FITNESS_ORIGIN` |
| `production` | `build.bent.fitness` | `build.bent.fitness://oauth` | `https://fitness.bent.build` |

`APP_VARIANT` selects the variant and defaults to `production`. Build settings:

- `FITNESS_OAUTH_ISSUER`: Clerk's OAuth issuer, such as `https://clerk.example.com`. Development builds also accept `http://127.0.0.1`.
- `FITNESS_OAUTH_CLIENT_ID`: the "Fitness iOS" OAuth application's client ID.
- `FITNESS_ORIGIN` (development only): another Fitness origin, HTTPS or `http://127.0.0.1:<port>`.

These are public values. Without the OAuth settings, the app says sign-in is not set up in the build. The native module pins every request to the build's Fitness origin and refuses redirects to another origin.

## Development

Use Node.js 24, Bun 1.4.4, Xcode, CocoaPods and SwiftLint. From the repository root, run `bun install --frozen-lockfile`. Generated `ios/` stays out of the repository.

```sh
cd apps/fitness-ios
bun run typecheck && bun run lint && bun run knip && bun run test
bun run config:development
node scripts/native.mjs prebuild    # ios/ for APP_VARIANT
node scripts/native.mjs build       # Simulator build
node scripts/native.mjs core-test   # XCTest for the Swift module
node scripts/native.mjs lint        # SwiftLint
```

Build output goes to `NATIVE_BUILD_DIR`, or `~/Library/Caches/fitness-ios-build`.

`modules/fitness-health` is a local Expo module. `ios/Core` holds the sync engine with no HealthKit or UIKit dependency, and `ios/Package.swift` builds it with its XCTest suite on its own. `ios/Platform` adapts it to HealthKit, the Keychain, files, `URLSession` and background time, and `ios/Module` exposes it to JavaScript. The config plugin adds the HealthKit and background-delivery entitlements and the Health read purpose string.

### Simulator

A Simulator build signed to run locally, with no paid team, carries its HealthKit entitlements in the binary's `__entitlements` section, and HealthKit works with them: the app requests read access and reads samples another app wrote.

`tools/health-seed` is a separate Simulator-only Xcode project. Its Health Seed app (`build.bent.fitness.healthseed`) asks for write access and writes synthetic samples relative to today: weigh-ins over three days, two on one day, and one two days ahead; an outdoor run and a treadmill run with distance; a run without distance; and a run whose distance sample is attached after the workout is saved. Each sample has a sync identifier, so seeding again replaces it. Launch it with `-action seed` or `-action clear` to run without a tap. bent Fitness can read these samples only when its own read access is allowed, since another app wrote them.

XCUITest drives the Health access sheet, which appears in the requesting app's window. `SimulatorFlows/HealthSheet.swift` allows or denies with it:

- The "Select All" cell has the identifier `UIA.Health.AuthSheet.AllCategoryButton`, and each type has a switch.
- The confirming button at the end of the list is Allow. On iOS 27.2, a read-only request, like the one bent Fitness makes, shows Continue instead.
- On iOS 27.2, a read request then asks how much history to share: "Past 30 Days and Future Data" or "All Recorded Data and Future Data". Allow stays disabled until one is chosen. The Health step shows the earliest weigh-in and run the app can read, so a 30-day choice shows there.
- Don't Allow is followed by an alert saying categories can be turned on later in the Health app.
- The read sheet notes that background access follows Settings → General → Background App Refresh.

On a newly booted Simulator, the sheet can take more than 20 seconds to appear, and HealthKit's request can fail with "Authorization session timed out" before it does. The flows ask again when that happens.

### Simulator flows

`scripts/flows.mjs` builds the development variant against a local harness, then runs each flow on a new Simulator, once more on another new Simulator if it fails. Each attempt starts with `POST /__reset`, which gives the harness an empty account and zero request counts. The harness serves every flow, so it runs with `FITNESS_TEST_DEADLINE_MS=3600000` in place of the Fitness tests' 15-minute deadline. In every flow, the harness counts no imports before consent, after a relaunch at the consent screen, or after a relaunch at the Health step.

- **Denied:** sign in, confirm consent, deny Health access. The app shows that it can read nothing, the sync sends no import request, and Disconnect revokes the key.
- **Allowed:** sign in, confirm consent, allow Health access to all history. The sync sends the earliest weigh-in for each seeded day and three runs: 5 and 4.2 km recorded with their workouts, and 3.1 km from the distance sample attached after the workout was saved. The run without a distance waits for distance access, and the weigh-in dated ahead waits until it is due. A second Sync now, waited for by its own completion time, sends no import request. Send 1 run without distance then sends the waiting run, which Fitness records as 0 km.
- **Partial:** sign in, confirm consent, allow Weight and Workouts but not Walking + Running Distance. The weigh-ins sync, no run is sent as 0 km, and the status screen says runs are waiting for distance access.

The harness (`apps/fitness/tests/ios-simulator.harness.test.ts`) serves the real Fitness device and import handlers on Postgres with the synthetic Clerk fake, plus a synthetic OAuth server that signs in a synthetic account and checks the PKCE verifier and redirect URI. No Clerk instance or secret is involved.

```sh
docker run -d --rm --name fitness-ios-pg -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=fitness_test -p 55432:5432 postgres:16
FITNESS_TEST_DATABASE_URL=postgres://test:test@127.0.0.1:55432/fitness_test node scripts/flows.mjs
docker stop fitness-ios-pg
```

Background delivery is not available in the Simulator. Background and locked-device behaviour is checked on an iPhone.

## Tests

- `bun run test`: the screens, consent copy, error guidance, the retry rules for connecting, and the variants.
- `node scripts/native.mjs core-test` (also `bun run native:test`): the sync engine with fake HealthKit and a fake Fitness ledger, covering backfill by account day, daylight-saving changes at midnight and at 23:00, resuming, split days, timezone changes, cutoff changes, deferred and unreadable samples, run distance and distance access, lost replies, interrupted checkpoints, expiry and write fencing, checkpoints racing a history change or a disconnect, distance coverage from Health's answer, a locked Keychain, the coordinator, the device lifecycle with overlapping enrollment attempts and sign-ins cancelled mid-retry, consent tied to its enrollment, and revocation timing. It also decodes every committed reply in `apps/fitness/tests/fixtures/wire/replies` with the production decoder.
- `node scripts/roundtrip.mjs` (needs `FITNESS_TEST_DATABASE_URL`): Swift encodes synthetic requests, `apps/fitness/tests/ios-roundtrip.test.ts` sends them to the real import handler as a device key and records real enrollment, import and disconnect replies, and Swift decodes them. The replies cover each outcome the requests produce, `timezone_changed`, `too_many_samples`, `rate_limited`, `issuance_pending` and `issuance_failed` with `Retry-After`, Clerk outages on every route, both `Authorization` forms, and a disconnect retried after its reply was lost.
- `node scripts/fingerprint-check.mjs`: the native fingerprint stays the same after a JavaScript change and changes after a Swift or config plugin change.
- `node scripts/flows.mjs`: the Simulator flows above.

## CI

Quality runs three jobs for this app:

- `fitness-ios` (Ubuntu): typecheck, lint, knip, unit tests, `expo config` for both variants, `expo-doctor` and the fingerprint check.
- `fitness-ios-native` (macOS 26 with Xcode 26.6): SwiftLint, production prebuild, Simulator build, the artifact check, the seeder build, the XCTest suite, and, with a temporary Homebrew `postgresql@16`, the round trip and the Simulator flows.
- `CodeQL Swift` (macOS 26 with Xcode 26.6 and Rosetta): builds the production app and the seeder, then traces two steps: Xcode's logged arm64 Swift compile commands for each first-party target (the app target with the Swift prebuild generates, the fitness-health module, Health Seed and its UI tests), and the module's Swift package with its XCTest targets. Traced, every process runs under Rosetta, which makes a whole Xcode build of the app take over an hour. The analysis build compiles whole-module and reads the app target's bridging header as source; with the header precompiled by Xcode's clang, the extractor records nothing for the app target. The analysis uses both security suites under the category `fitness-codeql-swift`, requires zero raw findings, checks that every tracked Swift file and every Swift file the app target compiles was extracted, and keeps the original SARIF.

The artifact check reads the production Simulator build: exactly the HealthKit and background-delivery entitlements, a Health read purpose string and no write purpose string, no local networking, the fitness-health module linked in, and no seeder files or symbols. Expo leaves out a local module whose minimum iOS version is above the app's, so the module's podspec matches the app's iOS 16.4.

`expo-doctor` runs with `react` excluded from its version check: the workspace uses React 19.3.1, and SDK 58 lists 19.3.0.

## EAS

`eas.json` has `development` and `production` profiles with Node 24, Bun 1.4.4 and the `macos-tahoe-26.5-xcode-26.6` image, and requires a committed tree. The EAS project and its owner are in `app.config.ts`. After installing dependencies on EAS, the `eas-build-post-install` script fails the build unless the image reports Xcode 26.6, the version CI builds and analyzes, and prints `Verified Xcode 26.6.` when it does. Production submissions go to the App Store Connect app that `submit.production.ios.ascAppId` names.

Each EAS environment sets the build's public OAuth settings: `FITNESS_OAUTH_ISSUER` and `FITNESS_OAUTH_CLIENT_ID` for that environment's Clerk instance and its Fitness iOS application. The `production` environment uses the production instance.

## Release

The **Deploy Fitness iOS** workflow (`.github/workflows/deploy-fitness-ios.yml`) builds an exact main commit on EAS and submits it to TestFlight. Run it from the Actions tab on `main`, with the full 40-character commit SHA of the current `main` head as `sha`. One release runs at a time.

It needs a GitHub environment named `fitness-ios-production`:

- Deployment branches: `main` only.
- Required reviewer: the repository owner, who approves each run before it starts.
- Secret `EXPO_TOKEN`: an Expo access token for the project's owner. Only the steps that run the EAS CLI receive it.

The workflow, on `macos-26`:

1. Requires `sha` to be the commit the run started from, and checks it out without keeping credentials.
2. Requires the commit to be current `main`, merged from a reviewed pull request whose head passed native CodeQL and independent review, with every Quality job passed, using the same gate as the other deploy workflows. It checks this again before the build and before the submission, and stops if the Quality run changed.
3. Installs with the frozen lockfile and checks that the checkout is clean, has no `.easignore`, and that `eas.json` pins the EAS CLI version, which it installs.
4. Checks the production iOS build settings twice: as `scripts/release-ios.mjs` resolves them, with the profile's `extends` chain and then its `ios` settings applied, and as the pinned EAS CLI's own `@expo/eas-json` resolves and converts them. The build must be a Release store build of the production variant in the `production` environment, on `macos-tahoe-26.5-xcode-26.6`, with remote credentials and `autoIncrement: true`. `simulator`, `developmentClient` and `withoutCredentials` must be absent or `false`, and a custom build config, prebuild command, scheme or enterprise provisioning must be absent; eas-json reads `"true"` as `true`, so each value must have its exact type.
5. Reads `FITNESS_OAUTH_ISSUER` and `FITNESS_OAUTH_CLIENT_ID` from the `production` EAS environment and checks them against production:
   - `fitness.bent.build/.well-known/oauth-protected-resource` must name that issuer as its only authorization server.
   - `/api/health/devices/ready?clientId=<client>` must reply `200 {"enrollment":"enabled"}`, while an unlisted client gets `403 client_not_allowed`.
   - The issuer must offer `fitness:health:enroll` with PKCE S256, and must know the client. The check reads the instance's sign-in page from `<issuer>/v1/environment` and starts an authorization request with the client, the production redirect URI, the `fitness:health:enroll openid` scope, the MCP resource, a random state and an S256 challenge, without following redirects or signing in. `/oauth/authorize` must send it to that sign-in page, returning to the issuer's own `/oauth/authorize-with-immediate-redirect`; that step must send it to the sign-in page again, returning to `/oauth-consent` on the same accounts host. Each step must answer with a 301, 302, 303, 307 or 308 redirect, the sign-in page and both returns must be HTTPS on the default port with no user information and no `#`, and both returns must carry the request's eight authorization parameters exactly. Clerk answers an unknown or deleted client with `invalid_client`, a redirect URI the client does not have with `invalid_request`, and a scope the client may not request with `invalid_scope`, and any of these, or any other redirect, stops the release.
6. Requires `eas build:list` to show no production build of the commit, then runs `eas build --profile production --platform ios --non-interactive`.
7. Requires one finished store build of the production bundle ID from exactly that commit in this EAS project, with the Xcode check in its log. It downloads the signed `.ipa` and checks it: exactly the HealthKit and background-delivery entitlements, no debugging entitlement, the production application identifier, a Health read purpose string and no write purpose string, no local networking, the fitness-health module linked in and no seeder. Its embedded app config must be the production variant with the checked issuer and client.
8. Reads the EAS environment again and requires the same issuer and client, checks production and the issuer again, checks that `fitness.bent.build/privacy` serves the privacy policy, then submits that build with `eas submit --id <build>`. EAS adds it to an internal TestFlight group.
9. Writes the status, commit, build ID, version and build number to the run summary, and removes the archive, the EAS output and the EAS CLI whatever the outcome. It uploads nothing. Archive and log URLs are fetched, never printed.

Each step has a time limit; the build has 150 minutes and the job 240. `scripts/release-ios.mjs` holds the checks, as subcommands that read and write files under `$RUNNER_TEMP`; its tests also check the workflow itself.

Builds and submissions use the signing credentials and the submission key stored in EAS: the distribution certificate, the App Store provisioning profile and the App Store Connect API key for EAS Submit. To set them up again, run `eas credentials --platform ios` from `apps/fitness-ios` in a terminal, signed in to Expo, with `EXPO_ASC_API_KEY_PATH`, `EXPO_ASC_KEY_ID`, `EXPO_ASC_ISSUER_ID`, `EXPO_APPLE_TEAM_ID` and `EXPO_APPLE_TEAM_TYPE` set for the App Store Connect team key. The submission key can also be added under the project's credentials on expo.dev.

TestFlight builds expire after 90 days. Release again before then to keep the app installed.

[`fitness.bent.build/privacy`](https://fitness.bent.build/privacy) is the app's privacy policy, for App Store Connect.
