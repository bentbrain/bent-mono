# Pixel-isometric art direction

This project uses an original pixel-isometric visual language inspired by classic social-room games. Do not trace, copy, recolour, or redistribute existing Habbo Hotel sprites, rooms, UI, characters, logos, or proprietary assets.

## Projection

- Use a 2:1 isometric projection.
- Use a logical floor tile of 32×16 pixels.
- Measure object placement in whole grid cells.
- Render the scene to a fixed low-resolution canvas.
- Scale the canvas only by whole-number nearest-neighbour multiples.
- Never use free camera orbit, perspective projection, sub-pixel positioning, smoothing, or runtime raster rotation.

## Canonical directions

Every placeable or animated asset must provide:

1. north
2. east
3. south
4. west

The direction stored on an object is its world direction. The renderer selects a camera-relative authored view after applying the apartment camera quarter. Never create a missing direction by mirroring another view. Symmetrical assets still require four explicit manifest entries.

The apartment supports exactly four camera quarters. A quarter turn rotates world coordinates and changes the selected view of every asset. It must not interpolate through intermediate camera angles.

## Pixel construction

- Use hard one-pixel edges at the asset's native resolution.
- Use no antialiasing, blur, glow, soft transparency, or fractional alpha.
- Use transparent pixels only outside the silhouette or in intentional holes.
- Keep clusters deliberate; avoid isolated single-pixel noise.
- Use one-pixel dark outlines on foreground silhouettes.
- Break long outlines with material-aware coloured edges where needed.
- Use two to four value steps per material.
- Keep highlights compact and shadows blocky.

## Lighting

- Use one fixed north-west light source for every camera view.
- Rotate the object, not the light.
- Keep the top and north-west planes lighter.
- Keep south-east vertical planes darker.
- Do not bake floor shadows into sprites. The renderer owns contact shadows.

## Palette

Use only colours declared in `assets/palettes/apartment-hotel-v1.json` for production v1 assets. Transparent pixels are permitted and are not part of the colour count.

New palette colours require:

1. a documented material need,
2. comparison against the existing ramps,
3. an update to the palette version,
4. regeneration or explicit compatibility review of affected assets.

## Furniture

- Anchor each sprite at its floor-contact pivot.
- Declare a whole-cell width and depth footprint.
- Keep the visual footprint inside the declared footprint in all four directions.
- Keep height and volume consistent across views.
- Preserve handles, cushions, asymmetry, and material details on the correct physical side.
- Do not let props or decoration swap sides between directions.

## Characters and cats

- Preserve identity, markings, body proportions, accessories, and handedness across every direction and animation.
- Every animation must exist in all four directions.
- Keep feet or the body contact point locked to the same anchor.
- Keep loop timing and frame count consistent across directions.
- Use authored turn transitions only if they become necessary; initial movement switches on grid-aligned direction changes.

Required initial cat animations:

- idle
- walk
- sit
- sleep
- groom

## Review at native size

Always inspect assets at:

- 1× native size for cluster and silhouette decisions,
- 4× nearest-neighbour scale for production review,
- in-room scale against a tile grid,
- all four views together in north, east, south, west order.

An asset fails if a reviewer cannot identify the same object or character in every view without relying on its filename.

## September 2026 resolution and room update

At the user's request, the new renderer uses a 960 × 720 logical canvas and 240 × 240 sprite frames, up from 640 × 400 and 160 × 160. Projection remains exactly 2:1 at 96 × 48 pixels per metre. A 25 cm placement cell is 24 × 12 pixels. All authored frames are rerendered in Blender at the new resolution, not enlarged from old rasters. Canvas display scaling uses whole-number nearest-neighbour multiples, with scrolling when the native scene exceeds the viewport.

The new room renderer has its own photographic material palette `apartment-room-v2`. V1 furniture and character sprites remain compatible because the world-to-pixel scale and anchors are explicit. Raster views are never mirrored or rotated. Every rotation is authored from the same 3D model with fixed view-relative lighting. Canonical model north faces negative world Z; camera view selection follows the same positive quarter-turn transform as floor geometry.

## Fixed fittings palette and combined runs

The photo-derived fittings use `apartment-fixtures-v2`, a superset of the existing v1 and room-v2 colours. V1's cream highlight makes stainless steel and porcelain look yellow; its purple shadow shifts charcoal cabinetry. Fixtures instead use the existing room neutral ramps for metal, charcoal and ceramic, with the oak ramp for timber. Existing furniture retains its approved v1 colours; rigged cat revision v3 uses the neutral palette described below. The scene's scale, floor anchors and four authored directions are unchanged.

Kitchen cupboards and appliances share a 480 × 480 frame, anchored at 240,360, so adjoining surfaces occlude correctly and form one continuous run. Other fittings retain 240 × 240 frames at 120,180. Both frame sizes use the same native pixels per metre; no sprite is resized. Overhead cupboards are a separate four-view model so cutaway walls can hide them when facing their backs.

Fittings explicitly map apartment X,Z,height into Blender X,-Y,Z. Their camera uses a 30-degree elevation and a height correction matching the renderer's 60.72 pixels per metre. The generator asserts projected unit vectors in all four directions against the Canvas projection before rendering. This corrects the earlier asset generator's axis handedness and vertical slope for the new fittings. The nine existing furniture models have also been rerendered and reviewed in all four views with this corrected mapping. Use `scripts/fix_furniture_projection.py` followed by `pack_models.py --furniture-only` for these exports; `build_models.py` supplies the original mesh constructors.

## Rigged cat revision

The user requested existing cat models customised for Pearl and Maree. Their new `-v3` assets derive from Quaternius's CC0 rig. The render pipeline uses the corrected world/Blender mapping, eight frames per animation, neutral white/grey fur from `apartment-fixtures-v2`, and consistent material assignments across all four directions. The approved v1 palette was too purple for grey fur. Reusing the already documented neutral palette avoids introducing another palette version. Sitting, sleeping, grooming, jump and crouch poses are authored additions to the original idle/walk cycles.

## Live 3D lighting, September 9, 2026

At the user's request, the displayed apartment now uses Babylon.js and GLB geometry exported from the approved Blender sources. The earlier fixed-light and palette-quantisation rules apply to catalogue sprites and historical raster exports. Live scene materials use those base colours but respond continuously to Home Assistant lighting and sunlight. Glass uses restrained transparency.

Keep the 960 × 720 logical render resolution, disabled antialiasing, nearest-neighbour integer presentation and four discrete orthographic cameras. Geometry supplies every angle, including asymmetric doors and coat markings. Do not substitute mirrored raster views. The saved world positions and 60.72 pixels/metre height projection remain compatible.

Full-height wall and ceiling meshes cast shadows while remaining hidden from the cutaway camera. Sun shadow maps use limited PCF filtering to reduce striping at the native resolution. Cat morph targets retain the seven approved eight-frame animations and step through poses without interpolation.

Use `scripts/export_live_models.py` in Blender to rebuild `public/models`. Review in the real browser at all four angles and with day/night previews. Historical Canvas screenshot scripts do not validate the WebGL renderer. The user authorizes routine browser interaction and screenshot checks during development.

The user requested visible lamp glow. A small 512-pixel glow pass with a six-pixel kernel applies to emissive lampshades. The final image still renders at the fixed logical resolution with nearest-neighbour presentation. Light brightness and colour drive both visible shade emission and real scene illumination; timber parts never emit.

The Hommey bedding revision adds pale Spearmint and dusty Rhubarb linen ramps plus dark green/burgundy piping to `apartment-fixtures-v2`. Existing neutral ramps turned the reference green into grey during catalogue quantisation. Existing colours remain; all audited thumbnails and four-view sprites are repacked against the superset. Runtime bedding uses the photo-derived base colours independently of the timber finish.

## Public mobile navigation, September 10, 2026

September 11 photo objects extend the fixtures-v2 palette with three-step lime
green ramps for Numero IV upholstery and the carrot scratcher, and blue ramps
for the low chair and kettle. Existing olive colours quantised these greens to
ochre, while the older blue ramp made the kettle teal. Existing colours remain
unchanged; only the new assets use these ramps.
The sofa throw also has a pale-pink ramp. Existing neutral values made its
photographed pink appear grey in the catalogue; the cream chair throw remains
separate.

At the user's request, the public viewer allows continuous touch pinch zoom and pan of the existing canvas from 1× to 4× its fitted size. This presentation exception retains nearest-neighbour scaling, fixed logical resolution and four discrete camera rotations. It does not change saved placement or world geometry. The UI follows shop.bent.build's monochrome font, square corners and blue controls, with standard left/right arrows and circular slider thumbs.

The playground uses the same fitted-canvas presentation so the complete apartment and furniture catalogue fit together on laptops and phones. It retains the 960 × 720 render resolution, nearest-neighbour presentation, and four camera quarters. Zoom changes presentation only.
