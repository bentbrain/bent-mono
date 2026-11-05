# Product mockup sources

- `tote-black-print-bar-1001.webp` is the Black AS Colour Carrie Tote 1001
  front image published by The Print Bar at
  `https://assets.theprintbar.com/public/1756273196186-1001_CARRIE_TOTE_BLACK.webp`.
- `tote-cream-print-bar-1001.webp` is the Cream AS Colour Carrie Tote 1001
  front image published by The Print Bar at
  `https://assets.theprintbar.com/public/1756273200219-1001_CARRIE_TOTE_CREAM.webp`.

Both files were retrieved on 2026-08-24. The tote projection overlay uses The
Print Bar's published AS Colour 1001 front-side offsets and width.

`tee-black-cutout-v1.png` and `tee-white-cutout-v1.png` are story-video assets.
Their shared alpha silhouette is flood-filled from the exterior background of
the aligned black-shirt source. Using an explicit alpha channel preserves the
white fabric and avoids doing background detection while rendering every video.

`lifestyle-v4/` contains generated display templates, never customer artwork.
Regenerate with `node workers/video-renderer/src/compile-browser-mockups.mjs`
from the repository root after changing the approved photographs, masks or
calibration. Geometry is packed as 12-bit U/V coordinates into opaque RGB PNGs;
lighting PNGs contain diffuse gain, reflected light and destination coverage.
Their content-addressed filenames include the compositor and encoder versions.
Flat display bases use the existing product photographs at 768 pixels.

The same templates drive the primary Vercel renderer and the optional browser
backup. `server-manifest.json` resolves the checked-in assets inside the Node
function; the two manifests under `src/lib/` resolve browser URLs. Regeneration
updates all three together. V5 WebP output is delivered from R2 without a second
resize on the first customer request.

`packages/product-image-renderer/assets/displacement.wasm` is built from the
adjacent Rust source, with no third-party Rust crates. Install the
`wasm32-unknown-unknown` target and run
`bun run --filter @forever-tee/product-image-renderer compile:displacement` after
changing that source. Commit its binary and generated SHA-256 manifest together.
Regular checks verify those hashes and renderer parity without downloading a
Rust toolchain. The web route explicitly includes the binary and template
folder in Next's output trace.
