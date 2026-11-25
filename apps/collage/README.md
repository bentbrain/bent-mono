# Maya's Collages

Maya's Collages is a browser collage editor and public feed for square sticker collages.

Open [maya-collage.bent.build](https://maya-collage.bent.build) to browse the public feed. Sign in to make, save and publish collages.

<img src="../www/assets/screenshots/collage-desktop.webp" width="720" alt="Maya's Collages feed on desktop with a sample collage, its maker and date, and a Sign in button.">

- Public feed ordered newest first with infinite scroll, showing each collage with its maker and creation date, plus per-maker profile pages.
- Square canvas editor (`/create`) powered by Fabric.js with sticker categories, solid/gradient/image backgrounds, layer ordering, undo history and PNG downloads.
- Makers can keep collages private, publish them to the feed, edit or delete their work, and choose whether NSFW collages are shown.
- Built with Next.js, Clerk authentication, tRPC, Payload CMS (managing stickers, categories and backgrounds), Drizzle/Postgres, Convex and Cloudflare R2 / UploadThing media storage.

## Development

Use Node 24 and Bun 1.4.4. Install dependencies once from the monorepo root:

```sh
bun install --frozen-lockfile
cd apps/collage
```

Configure a local `.env` using the schema in [`src/env.js`](src/env.js). Required variables cover Postgres (`DATABASE_URI`), `PAYLOAD_SECRET`, Clerk keys (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_SIGN_IN_URL`) and `UPLOADTHING_TOKEN`, with optional Convex (`NEXT_PUBLIC_CONVEX_URL`), Cloudflare R2 and PostHog settings. Set `SKIP_ENV_VALIDATION=1` when running typecheck, lint or Knip without live credentials.

To start a local Postgres container and run the app:

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

`bun run test` runs the Convex security, Clerk handshake and Payload storage schema suites.

## Deployment

Maya's Collages deploys to Vercel from `apps/collage` (serving `maya-collage.bent.build` and `maya-collages.bent.build`), using Node 24, the pinned Bun bootstrap and the root lockfile. Keep database credentials, Clerk keys, Payload secrets and object storage tokens in the protected Vercel environment. Production releases use the root `bun run release:vercel` route with `Release qualification`.
