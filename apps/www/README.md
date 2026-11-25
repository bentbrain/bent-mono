# bent.build

The Next.js application for `bent.build` and `www.bent.build`.

Install dependencies from the monorepo root with Bun:

```sh
bun install --frozen-lockfile
bun run --cwd apps/www dev
```

The development site opens at `http://localhost:3000`. The homepage lists every app on the bent.build subdomains. `lib/apps.ts` holds each app's name, domain, description, screenshots and, for apps in this repository, a `source` link to their GitHub folder, and `components/showcase` renders the app sections. Fonts are bundled locally with `next/font/local`; shared design tokens come from `@bent/design-tokens`.

## Screenshots

Each app has a desktop and a mobile screenshot in `assets/screenshots`, named `<app>-desktop.webp` and `<app>-mobile.webp`. Capture desktop at 1440 × 900 and mobile at 390 × 844, both at 2× scale (light theme where the app has one), then save them as WebP at 1600 × 1000 and 780 × 1688. When a mobile screenshot's top edge is not white, set the app's `mobile.statusBar` in `lib/apps.ts` to that colour so the phone status bar matches.

This repository is public. Capture public pages or local runs with synthetic data. Screenshots may show only people who have agreed to appear, and must not show account details, locations, vehicle data or private guide content.

Run the application checks from the repository root:

```sh
bun run --cwd apps/www lint
bun run --cwd apps/www typecheck
bun run --cwd apps/www knip
bun run --cwd apps/www build
```

Configure the deployment project root as `apps/www` and install dependencies from the monorepo root. Preserve its current domain mapping and deployment controls.
