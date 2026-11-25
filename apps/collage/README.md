# Maya's Collages

Maya's Collages is a browser collage editor and public feed for square sticker collages.

Open [maya-collage.bent.build](https://maya-collage.bent.build) to browse the public feed. Sign in to make, save and publish collages.

<img src="../www/assets/screenshots/collage-desktop.webp" width="720" alt="Maya's Collages feed on desktop with a sample collage, its maker and date, and a Sign in button.">

- Public feed ordered newest first with infinite scroll, showing each collage with its maker and creation date, plus per-maker profile pages.
- Square canvas editor (`/create`) powered by Fabric.js with sticker categories, solid/gradient/image backgrounds, layer ordering, undo history and PNG downloads.
- Makers can publish collages to the public feed or keep them off the public feed, edit them, remove them from the app, and choose whether NSFW collages are shown. Saving uploads the rendered JPEG to public object storage; hiding a collage from the public feed or removing it from the app updates the app record, while the uploaded JPEG remains in object storage and stays viewable to anyone with its direct image URL.
- Built with Next.js, Clerk authentication, tRPC, Payload CMS (managing stickers, categories and backgrounds), Drizzle/Postgres, Convex and Cloudflare R2 / UploadThing media storage.

## Development

Use Node 24 and Bun 1.4.4. Install dependencies once from the monorepo root:

```sh
bun install --frozen-lockfile
cd apps/collage
```

Configure a local `.env` using the schema in [`src/env.js`](src/env.js). Required variables cover Postgres (`DATABASE_URI`), `PAYLOAD_SECRET`, Clerk keys (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_SIGN_IN_URL`) and `UPLOADTHING_TOKEN`, with optional Convex (`NEXT_PUBLIC_CONVEX_URL`), Cloudflare R2 and PostHog settings. Set `SKIP_ENV_VALIDATION=1` when running typecheck, lint or Knip without live credentials.

To start a local Postgres container with `./start-database.sh`, set both `DATABASE_URI` (used by Next.js and Drizzle) and `DATABASE_URL` (read by `start-database.sh` to extract the container password and port) in `.env` to the same URL using the `postgres` user, `maya-collage` database, an explicit port and a URL-safe non-default password:

```env
DATABASE_URI=postgresql://postgres:<URL-SAFE-PASSWORD>@localhost:5432/maya-collage
DATABASE_URL=postgresql://postgres:<URL-SAFE-PASSWORD>@localhost:5432/maya-collage
```

Then start the database, push the schema and run the dev server:

```sh
./start-database.sh
bun run db:push
bun run dev
```

## Checks

Run the application checks from `apps/collage`:

```sh
bun run lint
bun run typecheck
bun run test
bun run knip
bun run build
```

`bun run test` runs the Convex security (`test:security`), Clerk handshake (`test:auth`) and Payload storage schema (`test:storage-schema`) suites.

`test:storage-schema` creates and alters `public.media`, so it requires a fresh disposable local PostgreSQL database named `payload_migration_test` on `localhost` or `127.0.0.1` alongside synthetic Payload and R2 fixture values (matching `.github/workflows/quality.yml` and `scripts/ci-check.mjs`):

```sh
docker run --rm -d --name maya-collage-test-db \
  -e POSTGRES_USER=test \
  -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=payload_migration_test \
  -p 127.0.0.1:5433:5432 postgres:16

until docker exec maya-collage-test-db pg_isready -h 127.0.0.1 -U test -d payload_migration_test >/dev/null 2>&1; do
  sleep 1
done

SKIP_ENV_VALIDATION=1 \
PAYLOAD_SECRET=synthetic-build-fixture \
PAYLOAD_MIGRATION_TEST_DATABASE_URI=postgresql://test:test@127.0.0.1:5433/payload_migration_test \
PAYLOAD_STORAGE_SOURCE=r2 \
R2_BUCKET=fixture-bucket \
R2_ENDPOINT=https://storage.example.invalid \
R2_PUBLIC_URL=https://media.example.invalid \
R2_ACCESS_KEY_ID=fixture-access \
R2_SECRET_ACCESS_KEY=fixture-secret \
bun run test

docker rm -f maya-collage-test-db
```

## Deployment

Maya's Collages deploys to Vercel from `apps/collage` (serving `maya-collage.bent.build` and `maya-collages.bent.build`), using Node 24, the pinned Bun bootstrap and the root lockfile. Keep database credentials, Clerk keys, Payload secrets and object storage tokens in the protected Vercel environment. Production releases use the root `bun run release:vercel` route with `Release qualification`.
