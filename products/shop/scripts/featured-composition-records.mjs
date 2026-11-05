const check = (value, reason) => { if (!value)
    throw Error(`Composition manifest rejected: ${reason}`); };
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export function compositionRecords(manifest) {
    const m = manifest;
    check(m?.schemaVersion === 1 && m.printMode === "base-image-only" &&
        [m.commandId, m.designId, m.outerRevisionId, m.innerRevisionId].every(uuid) &&
        Number.isSafeInteger(m.createdAt) && m.createdAt > 0 && m.sources?.length === 2 && m.products?.length === 2 && m.jobs?.length === 4, "complete immutable identities required.");
    const ids = [m.commandId, m.designId, m.outerRevisionId, m.innerRevisionId, ...m.products.map(p => p.id), ...m.jobs.map(j => j.id)];
    check(ids.every(uuid) && new Set(ids).size === ids.length, "new distinct UUIDs required.");
    const placement = p => p && [p.placementX, p.placementY, p.placementWidth].every(Number.isFinite) &&
        p.placementX >= 0 && p.placementY >= 0 && p.placementWidth > 0 && p.placementWidth < 1 &&
        p.placementX + p.placementWidth <= 1 && p.placementY + p.placementWidth <= 1;
    for (const [index, source] of m.sources.entries()) {
        check(source.role === (index === 0 ? "outer" : "inner") && /^[a-f0-9]{64}$/.test(source.sha256 ?? "") &&
            Number.isSafeInteger(source.size) && source.size > 0 && source.size < 25000000 &&
            [source.width, source.height].every(n => Number.isInteger(n) && n > 0 && n <= 12000) &&
            source.crop && [source.crop.cropX, source.crop.cropY, source.crop.cropZoom].every(Number.isFinite) &&
            source.crop.cropX >= 0 && source.crop.cropX <= 1 && source.crop.cropY >= 0 && source.crop.cropY <= 1 &&
            source.crop.cropZoom >= .65 && source.crop.cropZoom <= 2.6 && (index === 0 ? !source.placement : placement(source.placement)), "bounded source, crop and chest placement required.");
    }
    check(m.sources[0].sha256 !== m.sources[1].sha256 && m.sources.reduce((n, s) => n + s.size, 0) <= 25000000, "distinct bounded sources required.");
    const bases = { ["a51b7acf-77e9-4762-83c4-62d96dd8942c"]: "bent-shirt", ["97b629d7-1d3b-4d2a-a586-537168141e97"]: "cotton-tote" };
    check(new Set(m.products.map(p => p.baseProductId)).size === 2 && m.products.every(p => bases[p.baseProductId] === p.handle && placement(p.placement) && p.depth === 5), "exact reviewed shirt and tote required.");
    check(m.jobs.every(j => m.products.some(p => p.id === j.productId && (p.handle === "bent-shirt" ? ["Black", "White"] : ["Black", "Cream"]).includes(j.colour))) &&
        new Set(m.jobs.map(j => `${j.productId}:${j.colour}`)).size === 4, "four distinct supported video variants required.");
    const sourceRow = s => ({ artwork_key: `designs/${m.designId}/artwork/${s.sha256}`, content_type: "image/png", byte_size: s.size,
        sha256: s.sha256, artwork_width: s.width, artwork_height: s.height, crop_x: s.crop.cropX, crop_y: s.crop.cropY, crop_zoom: s.crop.cropZoom });
    const design = { id: m.designId, owner_id: null, ...sourceRow(m.sources[0]), placement_x: 0, placement_y: 0, placement_width: .08, depth: 1,
        status: "ready", version: 0, finalized_at: m.createdAt, created_at: m.createdAt, updated_at: m.createdAt,
        default_product_color: "White", default_product_color_status: "complete", default_product_color_model: "owner-reviewed-featured-v1" };
    const revisions = m.sources.map((s, index) => ({ id: index === 0 ? m.outerRevisionId : m.innerRevisionId, design_id: m.designId,
        fingerprint: `featured-composition-v1:${m.commandId}:${s.role}`, ...sourceRow(s), placement_x: 0, placement_y: 0, placement_width: .08, depth: 1,
        video_placement_x: s.placement?.placementX ?? null, video_placement_y: s.placement?.placementY ?? null,
        video_placement_width: s.placement?.placementWidth ?? null, created_at: m.createdAt }));
    const products = m.products.map(p => ({ id: p.id, base_product_id: p.baseProductId, design_id: m.designId, design_revision_id: m.outerRevisionId,
        shopify_handle: p.handle, placement_x: p.placement.placementX, placement_y: p.placement.placementY, placement_width: p.placement.placementWidth,
        placement_depth: p.depth, projection_version: "safe-margin-v1", default_color: "White", status: "active", created_at: m.createdAt,
        print_mode: "base-image-only", video_recursive_revision_id: m.innerRevisionId }));
    const jobs = m.jobs.map(j => ({ id: j.id, product_id: j.productId, design_revision_id: m.outerRevisionId, colour: j.colour,
        renderer_version: "story-video-renderer-v7", story_key: `story-videos/v7/${m.outerRevisionId}/${j.productId}/${j.colour.toLowerCase()}.mp4`,
        status: "queued", attempt_count: 0, created_at: m.createdAt, updated_at: m.createdAt }));
    return { design, revisions, products, jobs };
}
export function compositionStatements(manifest, releaseId, environment) {
    const records = compositionRecords(manifest), m = manifest;
    check(/^native-[1-9][0-9]+$/.test(releaseId ?? "") && ["development", "production"].includes(environment), "pinned native release and environment required.");
    let guard = "EXISTS (SELECT 1 FROM native_video_release_control WHERE singleton=1 AND paused=0 AND release_id IS NULL AND current_release_id=?)";
    const params = [releaseId];
    for (const p of records.products) {
        guard += " AND EXISTS (SELECT 1 FROM products WHERE id=? AND design_id IS NULL AND status='active' AND shopify_handle=?)";
        params.push(p.base_product_id, p.shopify_handle);
    }
    if (environment === "production") {
        const o = m.original;
        check(o && uuid(o.productId) && uuid(o.revisionId) && /^[a-f0-9]{64}$/.test(o.sha256 ?? "") &&
            Number.isSafeInteger(o.featuredRevision) && o.featuredRevision >= 0 && o.slot === 1, "reviewed original featured precondition required.");
        guard += ` AND EXISTS (SELECT 1 FROM featured_product_state WHERE id=1 AND revision=?)
      AND EXISTS (SELECT 1 FROM featured_products WHERE slot=1 AND product_id=?)
      AND EXISTS (SELECT 1 FROM products p JOIN design_revisions r ON r.id=p.design_revision_id
        WHERE p.id=? AND p.status='active' AND p.design_revision_id=? AND r.sha256=? AND p.print_mode='recursive' AND p.video_recursive_revision_id IS NULL)`;
        params.push(o.featuredRevision, o.productId, o.productId, o.revisionId, o.sha256);
    }
    const insert = (table, row, predicate, values) => ({ sql: `INSERT INTO ${table} (${Object.keys(row).join(",")}) SELECT ${Object.keys(row).map(() => "?").join(",")} WHERE ${predicate}`, params: [...Object.values(row), ...values] });
    const exists = "EXISTS (SELECT 1 FROM designs WHERE id=?)";
    return [insert("designs", records.design, guard, params),
        ...records.revisions.map(row => insert("design_revisions", row, exists, [m.designId])),
        ...records.products.map(row => insert("products", row, exists, [m.designId])),
        ...records.jobs.map(row => insert("story_video_jobs", row, exists, [m.designId]))];
}
export async function inspectComposition(db, manifest) {
    const records = compositionRecords(manifest);
    for (const [table, rows] of [["designs", [records.design]], ["design_revisions", records.revisions], ["products", records.products]]) {
        for (const row of rows) {
            const saved = await db.prepare(`SELECT ${Object.keys(row).join(",")} FROM ${table} WHERE id=?`).bind(row.id).first();
            if (!saved || Object.entries(row).some(([key, value]) => saved[key] !== value))
                return false;
        }
    }
    for (const row of records.jobs) {
        const saved = await db.prepare("SELECT product_id,design_revision_id,colour,renderer_version,story_key FROM story_video_jobs WHERE id=?").bind(row.id).first();
        if (!saved || Object.entries(saved).some(([key, value]) => row[key] !== value))
            return false;
    }
    return true;
}
