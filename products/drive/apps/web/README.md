# Drive web service

Next.js web service for drive.bent.build and tesla.bent.build. It provides authenticated Tesla OAuth, read-only MCP tools and protected account storage.

Install with Bun from the monorepo root. Run development commands from this directory. Configure the required values using `.env.example`; production configuration remains in the existing Vercel project.

Set both `BENT_DRIVE_ADMIN_GITHUB_USERS` and `BENT_DRIVE_ALLOWED_GITHUB_USERS` explicitly. The public source supplies no account allowlist. Invitations bind to immutable provider user IDs after the first accepted login, and revocation disables access and active MCP tokens. Keep GitHub-only sign-in and the read-only Tesla scope.

Run `bun run lint`, `bun run typecheck`, `bun run test` and `bun run build` before publishing. Shared Tesla contract and MCP plugin changes also require their package checks.

The Vercel application root is `products/drive/apps/web`. Keep the existing project environment, data store, public Tesla verification key and OAuth callbacks. Never commit credentials, encryption keys, account data, tokens or vehicle records.
