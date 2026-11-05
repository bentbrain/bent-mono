---
name: design-pixel-character
description: Create, revise, validate, and approve strict four-view animated pixel-isometric cats, people, and apartment inhabitants for Apartment Hotel. Use for new characters, pet likenesses, animation sets, directional repairs, sprite-sheet packaging, or character visual QA.
---

# Design Pixel Character

Create one recognisable character with every animation authored in all four directions.

## Workflow

1. Read `../../../docs/pixel-isometric-art-direction.md` and `references/acceptance.md`.
2. Create `runs/characters/<character-id>/request.json` with identity, markings, proportions, accessories, palette ramps, required animations, and references.
3. Approve one canonical identity image before animation work.
4. Produce a four-direction turnaround in fixed north, east, south, west order. Preserve markings and physical-side details.
5. Produce each animation as one coherent four-direction family. Start with `idle`, then `walk`, `sit`, `sleep`, and `groom`.
6. Keep frame size, frame count, timing, baseline, and floor anchor consistent within an animation.
7. Create the character manifest using `references/manifest-example.json` as the structural reference.
8. Run the validator from the repository root:

```bash
bun .agents/skills/design-pixel-character/scripts/validate_manifest.ts <manifest-path>
```

9. Produce a QA sheet with the turnaround, every animation strip at 4× nearest-neighbour scale, and an in-room preview.
10. Inspect identity, direction, animation continuity, anchors, palette, lighting, markings, and accessories before approval.
11. Copy only approved sheets, the manifest, source art, and QA previews into the corresponding approved asset folders.

## Repair

Repair a single directional strip only when the canonical turnaround and the other directions remain coherent. Redo the full animation family when timing, body volume, markings, or identity drift across multiple directions. Never patch a final frame by mirroring another direction.

## Hard gates

- Require north, east, south, and west for every animation.
- Reject runtime mirroring or raster rotation.
- Reject identity, marking, accessory, handedness, baseline, or scale drift.
- Reject partial alpha, smoothing, blur, glow, or off-palette production pixels.
- Reject animation families with mismatched frame counts or timing.
- Reject characters without native-size motion review and an in-room QA preview.
