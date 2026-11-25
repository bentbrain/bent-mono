# Fitness Sync

An iPhone app that sends Apple Health weigh-ins and running workouts to [Fitness](../fitness/README.md). It reads Health data, sends it to `POST /api/health/import` with an import-only device key, and shows what each sync did. Viewing and editing stay in Fitness on the web.

- The first sync sends your chosen history while the app is open.
- New weigh-ins and runs sync in the background whenever iOS wakes the app. iOS decides when that happens.
- Each time the app comes to the foreground, it catches up.

## How it works

1. **Sign in.** The app opens Clerk's sign-in in a private browser session with PKCE (S256), a random `state`, the variant's redirect URI, scopes `fitness:health:enroll openid` and `resource` set to the Fitness MCP endpoint. It exchanges the code for an access token and keeps it in memory for one request.
2. **Connect.** `POST /api/health/devices` exchanges that token for a device key. The key is stored in the Keychain (`AfterFirstUnlockThisDeviceOnly`) in a waiting state; nothing is read from Health or sent yet. Each attempt sends `enrollmentSequence`, one higher than the last attempt from this installation. The count is stored in the Keychain before the request goes out, so it keeps rising across relaunches and lost replies. Of the successful replies, the app keeps the key with the highest sequence; a success from a lower sequence is revoked, and a failed attempt leaves the stored key in place. Busy and unavailable replies, and `409 stale_enrollment`, are retried with the same token and a new sequence. Replies that use up the token ask for a fresh sign-in, and each refusal has its own message.
3. **Consent.** The consent screen shows the account email, the data types, the destination, when syncs happen, what Disconnect does and how much history to send. Confirming activates the key with an absolute start date. Cancelling revokes the key.
4. **Health access.** iOS asks which types the app can read: Weight, Workouts and Walking + Running Distance. The app then shows the earliest weigh-in and run it can read since the start date, or that it can read none.
5. **First sync (backfill).** The app records where each type's history ends, then sends whole days in the account timezone in order, up to 200 samples per request, with `expectedTimezone`. It marks a day done only after every request for it succeeds. If the account timezone changes, it regroups from the start date. When it reaches today, incremental sync takes over from the recorded position.
6. **Incremental sync.** Each page of up to 200 new samples is one request, and its position is saved only after Fitness accepts it with one outcome per sample. HealthKit observer queries and background delivery wake the app for new data; each run holds background time and completes HealthKit's handlers exactly once.

Samples dated after now wait until they are due. A run without a distance waits 6 hours for one, then is sent without one, and Fitness saves it as 0 km. A run whose distance could not be read is never sent as 0 km. The distance comes from the workout's statistics, then its associated distance samples, then its total distance.

The app keeps sample UUIDs, positions and per-run counts in `Application Support/sync/<account>/state.json`, protected until first unlock and excluded from backups. It keeps no Health values. Disconnect clears that file, revokes the key with `DELETE /api/health/devices/current`, and retries the revocation on later launches if the iPhone is offline. If an upload gets `401 key_invalid`, the app clears that key, if it is still the stored one, and asks to connect again. This also recovers when a later connection replaced the key on the server but its reply was lost. Logs carry codes and counts only, and the app has no analytics.

## Variants

| Variant | Bundle ID | Redirect URI | Fitness origin |
| --- | --- | --- | --- |
| `development` | `build.bent.fitness.dev` | `build.bent.fitness.dev://oauth` | `https://fitness.bent.build`, or `FITNESS_ORIGIN` |
| `production` | `build.bent.fitness` | `build.bent.fitness://oauth` | `https://fitness.bent.build` |

`APP_VARIANT` selects the variant and defaults to `production`. Build settings:

- `FITNESS_OAUTH_ISSUER`: Clerk's OAuth issuer, such as `https://clerk.example.com`. Development builds also accept `http://127.0.0.1`.
- `FITNESS_OAUTH_CLIENT_ID`: the "Fitness Sync iOS" OAuth application's client ID.
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

`tools/health-seed` is a separate Simulator-only Xcode project. Its Health Seed app (`build.bent.fitness.healthseed`) asks for write access and writes synthetic samples relative to today: weigh-ins over three days, two on one day, and one two days ahead; an outdoor run and a treadmill run with distance; a run without distance; and a run whose distance sample is attached after the workout is saved. Each sample has a sync identifier, so seeding again replaces it. Launch it with `-action seed` or `-action clear` to run without a tap. Fitness Sync can read these samples only when its own read access is allowed, since another app wrote them.

XCUITest drives the Health access sheet, which appears in the requesting app's window. `SimulatorFlows/HealthSheet.swift` allows or denies with it:

- The "Select All" cell has the identifier `UIA.Health.AuthSheet.AllCategoryButton`, and each type has a switch.
- The confirming button at the end of the list is Allow. On iOS 27.2, a read-only request such as Fitness Sync's shows Continue instead.
- On iOS 27.2, a read request then asks how much history to share: "Past 30 Days and Future Data" or "All Recorded Data and Future Data". Allow stays disabled until one is chosen. The Health step shows the earliest weigh-in and run the app can read, so a 30-day choice shows there.
- Don't Allow is followed by an alert saying categories can be turned on later in the Health app.
- The read sheet notes that background access follows Settings → General → Background App Refresh.

On a newly booted Simulator, the sheet can take more than 20 seconds to appear, and HealthKit's request can fail with "Authorization session timed out" before it does. The flows ask again when that happens.

### Simulator flows

`scripts/flows.mjs` builds the development variant against a local harness, then runs each flow on a new Simulator:

- **Denied:** sign in, confirm consent, deny Health access. The app shows that it can read nothing, the sync sends nothing, and Disconnect revokes the key.
- **Allowed:** sign in, confirm consent, allow Health access to all history. The sync sends the earliest weigh-in for each seeded day and the four runs: 5 and 4.2 km recorded with their workouts, 3.1 km from the distance sample attached after the workout was saved, and 0 km for the run without a distance. The weigh-in dated ahead waits, and a second sync sends nothing new.

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
- `node scripts/native.mjs core-test`: the sync engine with fake HealthKit and a fake Fitness ledger, covering backfill by account day, resuming, split days, timezone changes, deferred and unreadable samples, run distance, lost replies, interrupted checkpoints, expiry, locked data, the coordinator and the device lifecycle. It also decodes every committed reply in `apps/fitness/tests/fixtures/wire/replies` with the production decoder.
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

`eas.json` has `development` and `production` profiles with Node 24, Bun 1.4.4 and the `macos-tahoe-26.5-xcode-26.6` image, and requires a committed tree. The EAS project ID is in `app.config.ts`.
