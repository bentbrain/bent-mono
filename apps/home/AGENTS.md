# Apartment Hotel agent rules

## Runtime

- Use Bun for dependencies, package scripts, tests and TypeScript tooling.
- Use the repository root `bun.lock` and `bun install --frozen-lockfile`.
- Keep TypeScript strict. Do not introduce `any`, type casts, or non-null assertions.

## Pixel-isometric contract

- Read `docs/pixel-isometric-art-direction.md` before changing visual assets, projection, scene rotation, or rendering.
- Treat the four canonical directions as mandatory: north, east, south, and west.
- Do not mirror or rotate a raster sprite at runtime to create a missing view.
- Keep the camera to four 90-degree apartment rotations.
- Render at a fixed logical resolution with nearest-neighbour integer scaling.
- Keep object anchors, footprints, and world directions separate from camera-relative sprite views.

## Asset workflows

- Use `.agents/skills/design-pixel-furniture` for furniture and fixed apartment objects.
- Use `.agents/skills/design-pixel-character` for cats, people, and animated inhabitants.
- Do not place an asset in `assets/approved` until its manifest and visual QA pass.
- Keep disposable generation work under `runs/` or `assets/work/`; both are ignored.
- Commit approved source files, manifests, sprite sheets, and QA previews.

## Architecture

- Keep domain and projection logic out of React components.
- Keep Home Assistant entity IDs in data bindings, never embedded in sprite manifests.
- Represent vacuum coordinates in apartment world coordinates before projecting them.
- Add tests for every rotation, direction mapping, and asset-contract change.

## Development verification

The user authorizes routine screenshots, DOM inspection, clicking, resizing, and visual QA during development. Do not ask for separate browser-testing permission. Use preview controls to test lighting without operating real home devices.

## Public and private releases

Follow README.md for every shared feature/model release. Publish both targets from the same source; release the public Worker before the private card introduces new catalogue items. Furniture positions and finishes sync automatically through the outbound publisher. Keep private backups and purchase references out of public artifacts.
