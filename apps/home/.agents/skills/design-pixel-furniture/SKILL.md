---
name: design-pixel-furniture
description: Create, revise, validate, and approve strict four-view pixel-isometric furniture and fixed room assets for Apartment Hotel. Use when designing furniture, lamps, plants, appliances, doors, windows, cabinetry, decorations, or any placeable apartment object.
---

# Design Pixel Furniture

Create one production-ready furniture asset with four authored directions and a validated manifest.

## Workflow

1. Read `../../../docs/pixel-isometric-art-direction.md` and `references/acceptance.md`.
2. Create `runs/furniture/<asset-id>/request.json` containing the name, dimensions, footprint, materials, palette ramps, asymmetry, and visual references.
3. Prepare one canonical concept at 4× review scale. Keep the concept original; do not copy proprietary game sprites.
4. Produce a four-view sheet in fixed order: north, east, south, west. Keep native pixels, volume, light direction, and physical-side details consistent.
5. Separate the approved views into transparent PNG files. Do not mirror, rotate, antialias, or resample a view.
6. Create the asset manifest using `references/manifest-example.json` as the structural reference.
7. Run the validator from the repository root:

```bash
bun .agents/skills/design-pixel-furniture/scripts/validate_manifest.ts <manifest-path>
```

8. Create a QA preview showing the four native sprites at 4× nearest-neighbour scale plus one in-room placement.
9. Inspect anchors, footprint, silhouette, palette, light direction, material ramps, and asymmetric details.
10. Copy only approved PNGs, the manifest, source art, and QA preview into `assets/approved`, `assets/manifests`, `assets/source`, and `assets/previews`.

## Repair

Classify a failure as identity, direction, volume, palette, lighting, anchor, footprint, transparency, or file contract. Repair only the failed view when the remaining views still define a coherent source of truth. Regenerate the complete four-view family when physical details or volume drift across multiple views.

## Hard gates

- Require exactly four authored PNG views.
- Reject runtime mirroring or raster rotation.
- Reject partial alpha, smoothing, blur, glow, or off-palette production pixels.
- Reject inconsistent footprint, height, handedness, or light direction.
- Reject assets without a native-size and in-room QA preview.
- Keep work-in-progress files out of approved asset folders.
