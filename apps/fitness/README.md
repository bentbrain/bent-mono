# Fitness

A TanStack Start app for strength sessions, runs, food and bodyweight. Each invited account has private cloud storage in a dedicated Postgres database. Shared design tokens and controls come from the root workspace.

## Development

Use the root Bun version. Link the `fitness` Vercel project, provision a dedicated Neon development database, then pull the development environment into `.env.local`. Add the Clerk TanStack Start keys and the server-only `FITNESS_ALLOWED_EMAILS` list. Each address must match the account's verified primary email. An empty invitation list denies access.

```sh
bun run db:migrate
bun run dev
```

Run commands from `apps/fitness` after the repository storage preflight. `.env.example` lists the configuration keys. Keep development and production databases and Clerk applications separate. Claim an accountless Clerk development application through Clerk before configuring production.

The app checks the signed-in account and invitation on every server operation. SQL queries include the authenticated owner ID. Record revisions detect conflicting edits, and per-account request receipts make retries idempotent. Completed workouts retain their exercise prescriptions and results. Device drafts queue cloud writes and show saving, pending, failure and conflict states. Export pending changes before choosing a cloud version in a conflict.

## Training and food

Start with the included A/B dumbbell templates, then edit your schedule, targets, equipment and prescriptions in Settings. The introduction uses two sets per exercise for the configured number of weeks. Weights mean one dumbbell. Rows and split squats record both sides; planks record seconds. Progression suggestions require all prescribed sets to reach the top of the range with control and at least two reps in reserve. Add confirmed dumbbell sizes to get suggestions based on available weights.

Each included exercise has setup instructions, form cues, a YouTube tutorial and a six-panel illustration showing the movement from two angles. Open an illustration at full size to inspect the positions. The illustrations are AI-generated references. Read the written instructions and watch the demonstration before trying a new movement. Start light and stop if a movement hurts.

Food entries track calories and protein. Save regular meals for reuse. Weigh-ins use one current value per date; the chart shows the latest 60 recorded dates and an average of the latest seven weigh-ins. Compare trends over several weeks when adjusting food targets.

## Equipment photos and exports

Settings accepts up to 20 private JPEG, PNG or WebP equipment photos, each up to 2 MB. The server checks file signatures and ownership, and serves photos with private, no-store headers. Account export includes settings, entries, workout history and photo bytes. Store exports privately.

Add the site to your home screen through your mobile browser's share menu. The manifest opens it as a standalone app. Reconnect to load cloud data and finish pending saves.

## Feedback toolbar

The Fitness project at `https://toolbar.bent.build` allows the canonical app origin and local development origins. `.feedback-toolbar.json` contains its public installation settings. The shared layout loads the hosted embed. Account data, workout values, food, bodyweight and settings use the toolbar's redaction and privacy attributes.

## Checks and release

```sh
bun run lint
bun run typecheck
bun run test
bun run build
bun run knip
bun run test:browser
```

`FITNESS_TEST_DATABASE_URL` enables the Postgres integration tests. Use a disposable database or the dedicated development database. The tests create unique synthetic account IDs and remove only their own records. CI supplies its disposable Postgres service. Public browser checks verify the configuration boundary without provider credentials. Authenticated provider checks require a Clerk development application and invited synthetic accounts.

Run the root public-source and workspace checks before publishing. Vercel uses the app directory, Node 24, the pinned Bun bootstrap and the root lockfile. Production uses the repository's `release:vercel` route with independent review, security checks and `Release qualification`. Configure the dedicated production database and invited accounts before runtime qualification. Apply the schema to that database through the reviewed release procedure.
