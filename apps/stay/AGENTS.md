# Stay rules

- Keep private guide content, host details, network hostnames and household photographs out of public source and Git history.
- Production content comes only from private Blob storage. Preserve both published content and drafts. Never overwrite existing state during migration.
- Require Clerk authentication and guide authorization before rendering private content, serving assets or calling AI. Only the verified OWNER_EMAIL can manage invitations.
- Keep household controls behind the existing limited server bridge. Never accept user-supplied Home Assistant entity IDs or arbitrary service names.
- Use synthetic fixtures for local and preview verification, with the same authorization boundaries as production.
- Preserve the established UI and shared design tokens. Use strict TypeScript without type assertions or any.
- Run lint, typecheck, formatting, tests and production build before publishing.
- Production releases must originate from committed and pushed GitHub source. Keep the current deployment active until protected content/configuration and authenticated flows are verified.
- Before changing Next.js routes, read the installed guide under node_modules/next/dist/docs.
