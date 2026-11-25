# bent.build

The Next.js landing website for [bent.build](https://bent.build) and `www.bent.build`.

- Showcases every application on the bent.build subdomains with desktop and phone previews, access notes and links to each live site and public source folder.
- Stores each app's metadata, screenshots and source URL in [`lib/apps.ts`](lib/apps.ts), rendered by `components/showcase`.
- Bundles fonts locally with `next/font/local` and imports shared design tokens from `@bent/design-tokens`.

## Development

Use Node 24 and Bun 1.4.4. Install dependencies once from the monorepo root, then start the development server:

```sh
bun install --frozen-lockfile
bun run --cwd apps/www dev
```

The development site opens at `http://localhost:3000`.

## Screenshots

Each app has a desktop and a mobile screenshot in `assets/screenshots`, named `<app>-desktop.webp` and `<app>-mobile.webp`. Capture desktop at 1440 × 900 and mobile at 390 × 844, both at 2× scale (light theme where the app has one), then save them as WebP at 1600 × 1000 and 780 × 1688. When a mobile screenshot's top edge is not white, set the app's `mobile.statusBar` in `lib/apps.ts` to that colour so the phone status bar matches.

This repository is public. Capture public pages or local runs with synthetic data. Screenshots may show only people who have agreed to appear, and must not show account details, locations, vehicle data or private guide content.

## Checks

Run the application checks from the repository root:

```sh
bun run --cwd apps/www lint
bun run --cwd apps/www typecheck
bun run --cwd apps/www knip
bun run --cwd apps/www build
```

## Deployment

Configure the Vercel project root as `apps/www` and install dependencies from the monorepo root using the pinned Bun bootstrap. Preserve its current domain mapping and deployment controls.
