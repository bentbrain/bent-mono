# Stay

Authenticated guest guide, owner-managed drafts and invitations, AI answers grounded in the published guide and official manuals, Wi-Fi QR access, and limited home controls.

Bun manages this workspace. Run `bun run dev`, `bun run test`, `bun run lint`, `bun run typecheck`, and `bun run build` from this directory after the root workspace install.

## Private content

The public repository contains synthetic local and preview content. Production requires the existing private Vercel Blob store and never falls back to fixtures when storage or content is unavailable. Keep the old deployment serving guests until the private content and asset preparation below is verified.

Set the Clerk keys, verified `OWNER_EMAIL`, AI configuration and protected home bridge configuration in the existing deployment environment. Connect the existing private Blob store using `BLOB_STORE_ID` with Vercel OIDC or `BLOB_READ_WRITE_TOKEN`. Do not expose these through `NEXT_PUBLIC_` variables. The transfer command stores the original network URL in private `guide/home-controls.json`, resolved only after authorization through `/home-controls`. `HOME_CONTROLS_URL` can override that private configuration when explicitly set. Keep the controls bridge's Home Assistant token on its host.

From an already authenticated protected environment, prepare the private objects using the original private source archive and an outside-repository backup directory:

```sh
bun --conditions=react-server scripts/prepare-private-content.ts --source-root /path/to/private/original --backup-dir /path/to/private/backup
bun --conditions=react-server scripts/prepare-private-content.ts --source-root /path/to/private/original --backup-dir /path/to/private/backup --apply
```

The first command reads storage and writes only a private backup of existing CMS state. The second uploads missing objects with overwrite protection and verifies each object's SHA-256, including private home-controls configuration. Existing drafts and published documents remain unchanged. Different existing asset bytes block preparation. The original source, local controls environment and photographs remain intact. Never copy them into this repository.

Before switching deployment source, verify existing published and draft content, every authenticated photo and evacuation route, invitation restrictions, chat, Wi-Fi access and home controls against the existing app. A successful source build does not prove content transfer or authorize a domain cutover.
