# bent.build

The Next.js application for `bent.build` and `www.bent.build`.

Install dependencies from the monorepo root with Bun:

```sh
bun install --frozen-lockfile
bun run --cwd apps/www dev
```

The development site opens at `http://localhost:3000`. Edit `app/page.tsx` to change its content. Fonts are bundled locally with `next/font/local`; shared design tokens come from `@bent/design-tokens`.

Run the application checks from the repository root:

```sh
bun run --cwd apps/www lint
bun run --cwd apps/www typecheck
bun run --cwd apps/www knip
bun run --cwd apps/www build
```

Configure the deployment project root as `apps/www` and install dependencies from the monorepo root. Preserve its current domain mapping and deployment controls.
