# jp.bent.build

Blog. Astro and emDash on Cloudflare Workers, with D1 records and R2 media.

Public blog, categorised gallery, geolocated media map and beer counter. The owner uses a TipTap rich text editor with shadcn/Base UI controls and emDash passkey login. Owner tools preserve original media, fill missing capture metadata and export Instagram stories as PNG or animated MP4.

The application uses Tailwind utilities and shadcn components on Base UI. Theme tokens and the official shadcn state utilities live in `src/styles/globals.css`.

The homepage reads newest to oldest by post day, left to right and then down. Equal days use descending record IDs for stable pagination. Cards share the height of the tallest card in each row, with equal 16px gaps and unused final-row cells on the right.

Blog cards use a bounded horizontal carousel below 601px, with photos and videos fitted without cropping. Swipe horizontally or use the navigation buttons; vertical touch gestures scroll the page. Native video controls remain available. At wider widths, cards stack media vertically at equal widths and natural heights, followed by any attached shop design. Individual post pages retain their existing carousel. New gallery selections start in capture-time order, oldest first. Drag the gallery handles or use the earlier/later buttons in either owner editor to arrange them. Dragging scrolls the editor panel or page to reach offscreen media. Saved gallery order is preserved, including when more media is added.

## Development

Use Node 24 and Bun 1.4.4. Install dependencies once from the monorepo root, then run app commands from `apps/jp`.

```sh
bun install --frozen-lockfile
cd apps/jp
cp .env.example .env
bunx emdash secrets generate
bun run dev
```

Save the generated encryption key in the ignored `.env`. EmDash applies the schema on the first request. Development-only setup is available at `/_emdash/api/setup/dev-bypass`; it never works in a production build. `bun run demo` adds removable sample content to the local database only. No sample entries are bundled in the production seed.

```sh
bun run lint
bun run typecheck
bun run test
bun run test:integration
bun run test:e2e
bun run knip
bun run build
```

`bun run test` runs every unit and native Worker case with at most two test files at once. This bounds local Worker processes across the monorepo while preserving each case's concurrent-request checks.

`bun run test:e2e` runs the per-PR browser cases. `bun run test:e2e:full` runs every browser case, including the original 333 and the representative library journey. Quality runs the full regression on Monday at 05:00 UTC. A failed scheduled run fails the `browser` job with the failing case in its log.

Browser fixtures copy the app, shared packages, workspace manifests and patches into disposable monorepos, then install from the frozen lockfile offline. They keep dependencies and Astro/Vite caches separate from the source checkout. If Bun's package cache was cleared while `node_modules` remained, run `bun install --frozen-lockfile --force` from the monorepo root to refill it before running browser tests.

`bun run test:e2e:coverage` verifies the original canonical IDs and exact full/per-PR collections against `tests/browser-coverage.json`. The manifest records retained native cases, representative browser cases and contracts executed by `bun run test` or `bun run test:integration`. Collection equality does not establish assertion equivalence. Review the assertions when changing a disposition. The browser reporter rejects skipped or incomplete execution and writes sanitized case and fixture timing to `artifacts/browser/`. Quality uploads those artifacts for 14 days. Measurement spans can overlap; do not sum nested spans or infer Linux runtime savings from development-machine timings.

## Owner tools

- `/owner`: posts and daily beer entries.
- `/owner/posts/new` and `/owner/posts/:id`: rich text, media selection, optional shop design, drafts and publishing. Paste clipboard images directly into the editor, or choose a post-only photo from + MEDIA. These images stay outside the trip gallery and remain private until the post is published. Existing posts can be unpublished to an editable draft or moved to CMS trash after confirmation. Media and revision history stay in the CMS. Paste a public shop.bent.build product or featured link and choose black or white. The blog and post page show its flat t-shirt image and link to that product with the chosen colour.
- `/owner/media`: uploads, capture times, coordinates and multiple categories. Use SELECT to choose drafts and published photos, or SELECT ALL. EDIT changes titles, place and categories together. Only checked fields change; categories support add, remove and replace. Original capture metadata stays unchanged. Published photos update immediately; drafts stay private. Keep the selection to PUBLISH its drafts, or use SELECT ALL DRAFTS. Progress and per-photo errors appear together; failed photos stay selected for retry. Missing metadata keeps an upload unpublished. Upload preparation shows its current stage and stops after two minutes. A failed file does not block later files; RETRY FAILED FILES retains and retries preparation failures without resending successful uploads. Lost upload responses require checking the refreshed media list before retrying. Owner tools use TanStack Query with private, per-island memory caches. Accepted mutations update cached records immediately. Photo edits and publication run up to four independent requests at once; their forms finish without waiting for a full-library refresh. Failed or uncertain saves refresh in the background before retry. Upload batches refresh once to resolve new preview URLs. Bulk edit dialogs can close while saves continue, with progress and errors retained on the page.
- `/categories`: create categories and browse the generated icon library. Categories can also be created from the media page and selected on any media item. The native CMS has separate Categories and Category icons collections; generated icons are registered as image media. New categories reuse a valid icon with a matching name or supported synonym before queuing generation. Missing or corrupt icons generate through the existing bounded job queue. Regeneration retains earlier icons in the library.
- `/owner/export`: daily media selection, historical beer counts, safe-area preview and PNG/MP4 downloads.
- `/owner/newsletter`: connect Resend, preview the next digest, send a test to the owner inbox and enable or pause the schedule.
- `/_emdash/admin`: native CMS maintenance, revisions and passkey management.

Native CMS media links under `/media_items/:slug` redirect to `/media/:slug`. Native previews require both a valid preview link and the signed-in owner session. Preview and native edit-mode pages use feedback redaction, disable indexing and prevent caching. Media publication validates the same fields as the public loader, including photo/video kind. The public map fits Japan and all published media locations so pins outside Japan remain reachable.

Food, shopping, landscape, people, beer and origami use the owner-approved image-generated pixel artwork in `public/category-icons/`. These transparent 32px PNG masks inherit the current theme and selected-filter colour without JavaScript or a generation request. The approved contact sheet is preserved at `mockups/assets/category-icons-approved.png`. Other categories keep their existing generation and fallback behaviour.

Capture times group into days in `Asia/Tokyo`. Photos without an offset are interpreted as Japan time. Originals remain in private R2 storage. Draft previews require owner access; published files use a single live database membership query and disable caching so unpublication takes effect immediately. The image-transform endpoint is disabled because previews are already resized. Nominal ten-second videos allow 200 ms of frame timing tolerance, using the same rule in browser preparation, uploads and publication. The owner browser converts HEIC previews and short videos before upload and renders story exports with WebCodecs. Upload video previews target 8 Mbps and fit within a 1280px longest edge without enlarging smaller clips, keeping previews below the 32 MiB upload limit while original files remain unchanged. MP4 rendering needs a current Safari or Chrome with AVC encoding support. Story exports are silent.

Category icon jobs emit one bounded `category_icon_generation` terminal diagnostic per dispatched generation, with fixed stage and reason codes, elapsed milliseconds, a random operation ID, HTTP status when known and an opaque provider request ID only when it matches `req_` followed by 32 lowercase hexadecimal characters. Other request-ID formats are omitted. Events exclude category names, job identifiers, prompts, response bodies, credentials and raw errors. Diagnostic sink failures do not change generation outcomes. Events are best effort and may be absent if logging fails or the runtime terminates. These events help investigate future requests; they cannot establish the cause or recover the output of an earlier uncertain generation. Uncertain results still require explicit charge acknowledgement before retrying.

## Feedback toolbar

The shared layout loads the independent [feedback-toolbar](https://github.com/bentbrain/feedback-toolbar) once from https://toolbar.bent.build. Production CI supplies `PUBLIC_FEEDBACK_SERVER=https://toolbar.bent.build` and `PUBLIC_FEEDBACK_PROJECT_ID=prj_bc74b93bb6f44574`. Both values are public; incomplete or invalid configuration fails instead of loading an unintended script.

Toolbar sign-in uses its own GitHub account and Japan project membership. Blog owner login remains independent. Content and controls carry stable `data-feedback-id` attributes; the owner page body uses `data-feedback-redact` so controls remain selectable while unpublished drafts and metadata are excluded from captured text and accessible labels, including dialogs rendered outside the main content. The accompanying `data-feedback-private` marker on the main content keeps older embeds from capturing that content. Comments still require explicit submission.

The public `.feedback-toolbar.json` links local agent tools to this Japan project. Agent credentials stay in private user configuration outside the repository. An existing harness can use the connector's MCP tools to read threads and claim explicitly queued work; its schedule and execution permissions remain in that harness.

## Deployment and repository controls

PRs run strict ESLint, formatting, TypeScript, unit and full-flow tests, Knip and a production build. Main requires all nine quality and security checks, an up-to-date branch and resolved review conversations, with administrator enforcement. A separate T3 GPT-6.1 agent must review the exact PR head against the current main base before merge or auto-merge. Any head or base change requires another review. GitHub reviewer approvals are not required for this single-contributor repository. The complete authorization and review procedure lives in [AGENTS.md](AGENTS.md).

The `Independent review` commit status links the reviewed head SHA to independent review evidence. The owner may add that exact context to required branch-protection checks after the policy PR passes review. Preserve the existing nine contexts, strict checks, administrator enforcement and resolved-conversation requirement. Until that control change, agents must still enforce the documented review gate. Publish review status through the commit-status API; do not create an Actions job with the same name or treat a CI result as review evidence.

The review status is a PR merge gate. Squash merging creates a different main SHA; Quality runs again on main, and Deploy requires the latest run of each of the nine CI jobs to succeed for its checked-out SHA through `scripts/require-checks.mjs`. Leave that deployment list unchanged. Requiring the PR-head review status on the new squash SHA would block normal deployment, and copying success would falsely attest to a review of that SHA. Agents must use normal CI deployment and cannot push to main, bypass protection or deploy manually.

Secrets and local data are excluded from Git. Deployment configuration lives in `wrangler.jsonc`; application secrets belong in Cloudflare's encrypted secret storage. The verified deployment supplies `OPENAI_API_KEY` and `EMDASH_ENCRYPTION_KEY` from GitHub Actions secrets through a temporary private secrets file. EmDash validates the encryption key before Wrangler starts; missing or malformed keys block deployment without changing the Worker. Generate encryption keys with `emdash secrets generate`; preserve the existing key when encrypted plugin settings already exist. Replacing the key requires separate owner authorization under `AGENTS.md`.

The production account is the sole author. Public account creation and invitations are disabled. First-time passkey setup requires a short-lived private setup cookie. Generate a setup capability and keep it private; clear `SETUP_TOKEN` after registering the owner account.

Email-link sign-in uses EmDash's native Cloudflare email provider and the `EMAIL` sending binding. It sends from `login@auth.jp.bent.build`; Cloudflare Email Sending must be enabled for `auth.jp.bent.build` with its generated DKIM, SPF and return-path records. This sending subdomain is separate from the existing `bent.build` inbound mail forwarding. Passkeys remain available, and email links sign in only to an existing account. Open the emailed link in the browser session you want to authenticate.

## Newsletter

The native `japan-newsletter` EmDash plugin sends through Resend with React Email templates. Public pages have an email signup form. Confirmation links expire after 24 hours and require an explicit button press; opening a link alone never subscribes someone. Subscriber addresses and consent timestamps stay in private plugin storage. Unconfirmed signups expire after seven days. The form has bounded per-address, per-IP and daily confirmation limits.

Connect a full-access Resend key at `/owner/newsletter`. EmDash encrypts it using the existing `EMDASH_ENCRYPTION_KEY`; it is never returned to the client. Connection creates a dedicated Resend segment. Resend Broadcasts handles unsubscribes and delivery suppression. Sending uses `hi@jp.bent.build`, with `Reply-To` set to `OWNER_EMAIL`. The owner inbox is visible to recipients when replying; this does not provision an incoming mailbox for direct messages to `hi@jp.bent.build`.

Automatic sending starts paused. The default is Sunday at 18:00 in `Asia/Tokyo`; the owner can select another weekday/hour or a 1–30 day interval. The existing Cloudflare cron drives the EmDash task every five minutes. Digests contain up to 24 published blog posts not included in a previous digest, including entries added later for an earlier day. Drafts, trashed entries and sample content are excluded. Quiet periods are skipped. Owner test emails do not consume entries or go to subscribers.

Day numbering uses the earliest published photo capture in Asia/Tokyo, with the earliest published post date as a fallback when there are no photos. Beer entries, drafts and sample records do not shift a real trip. The blog, owner tools, story exports and newsletter share this calculation. Existing `day X:` post-title prefixes are recalculated for display; the title text and stored dates stay intact. Digest headings link to each entry as `day X: title`, preserving calendar gaps and trip day numbers across digests. Each entry includes its complete story text without a character cutoff, its public photos in order and, when selected, its shirt design linked to the public shop product and colour. The digest ends with the shop banner and unsubscribe footer. Confirmation emails contain only the confirmation heading, action and expiry footer.

The Cloudflare `IMAGES` binding makes JPEG copies bounded to 1120 × 3360 pixels and 150 KB each. Copies have location and other embedded metadata removed and are reused under `newsletter-images/v1/` in the existing private media bucket. Originals and their capture records remain intact. Image URLs check the current published entry, media selection and public shop design before serving; removing or unpublishing a source stops access. Missing or oversized selected images block preparation rather than silently disappearing from a digest. Previewing the next digest also prepares its image copies. Saved drafts from an older template must be discarded and rebuilt before sending.

Private send records and a revision-fenced lease prevent overlapping dispatch. The newsletter hook has a ten-minute timeout with a nine-minute send lease, including time for the final publication checks. Photos are prepared in batches of at most four, preserving their order. Expired preparation cannot create or send a broadcast. Each scheduled check reconciles interrupted runs against their saved provider ID after the active lease expires. A delivered broadcast is recorded as sent; a verified unsent draft stays blocked for owner recovery. Unknown outcomes never trigger a fresh broadcast automatically. The owner can resume an unchanged saved draft or discard a verified unsent draft so changed entries return to the next scheduled digest. A lost deletion response remains blocked until its saved ID is reconciled. Newsletter preview pages are private and sandboxed, and confirmation pages disable caching and referrers. No extra schema migration or deployment-workflow change is required.

## Design review and sample assets

`node mockups/server.mjs` serves the approved mockups at `http://127.0.0.1:4317`. Their publishing and export actions are simulations. Saved feedback and private tunnel credentials live in the ignored `review-data/` directory.

The separate `/post-design.html` review page uses sample travel content and an existing public shop design. Its controls change only the preview. The shop project remains independent; the blog uses its public flat-image endpoint.

For an existing database, add the optional field before deploying this feature: `bunx emdash schema add-field posts shop_design --type json --label "shop design" --url <instance-url>`. New databases receive it from the seed. Schema changes and deployment require a separate approved rollout.

The interface follows shop.bent.build and stay.bent.build. The shirt mark belongs to the same owner. Sample photographs and provenance are listed in `mockups/assets/sources.json`; the sample video pans a sample photograph. The application map uses Natural Earth's public-domain 1:10m country geometry, with its pinned source recorded in `src/lib/japan.json`. Geist Mono uses the SIL Open Font License. Dependency licences remain with their packages.
