const PAGE_SIZE = 40;
const CURSOR = /^v1\.(\d{1,16})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const headers = { "Cache-Control": "private, no-store" };
// The old array response remains available to storefronts deployed before v2
// pagination. New clients opt into a bounded response with page=1.
export const SAVED_DESIGNS_QUERY = "\n  SELECT designs.id, designs.finalized_at, product.id AS product_id,\n    CASE WHEN product.base_product_id = '" + "97b629d7-1d3b-4d2a-a586-537168141e97" + "'\n      THEN 'Cream' ELSE product.default_color END AS color\n  FROM designs JOIN products AS product ON product.id = (\n    SELECT id FROM products WHERE design_id = designs.id AND status = 'active'\n    ORDER BY CASE WHEN base_product_id = '" + "a51b7acf-77e9-4762-83c4-62d96dd8942c" + "'\n      THEN 0 ELSE 1 END, created_at DESC, id LIMIT 1\n  )\n  WHERE designs.owner_id = ? AND designs.finalized_at IS NOT NULL\n    AND designs.deleted_at IS NULL AND designs.status = 'ready'\n";
export async function listSavedDesigns(env: {
    DB: D1Database;
}, ownerId: string, url: URL) {
    const page = url.searchParams.get("page");
    const after = url.searchParams.get("cursor");
    const invalid = () => Response.json({ error: { code: "BAD_REQUEST", message: "Invalid saved-design page or cursor." } }, { status: 400, headers });
    if ([...url.searchParams.keys()].some(key => !["page", "cursor"].includes(key)) ||
        url.searchParams.getAll("page").length > 1 || url.searchParams.getAll("cursor").length > 1 ||
        (page !== null && page !== "1") || (after !== null && (page !== "1" || after.length > 56)))
        return invalid();
    const match = after?.match(CURSOR);
    const timestamp = match?.[1] === undefined ? undefined : Number(match[1]);
    const id = match?.[2];
    if (after !== null && (!id || timestamp === undefined || !Number.isSafeInteger(timestamp) ||
        timestamp < 0 || timestamp > 8640000000000000))
        return invalid();
    const cursor = id !== undefined && timestamp !== undefined;
    const query = `${SAVED_DESIGNS_QUERY}
    ${cursor ? "AND (designs.finalized_at, designs.id) < (?, ?)" : ""}
    ORDER BY designs.finalized_at DESC, designs.id DESC ${page ? "LIMIT ?" : ""}`;
    const parameters: (string | number)[] = [ownerId];
    if (cursor)
        parameters.push(timestamp, id);
    if (page)
        parameters.push(PAGE_SIZE + 1);
    const rows = await env.DB.prepare(query).bind(...parameters).all<{
        id: string;
        finalized_at: number;
        product_id: string;
        color: string;
    }>();
    const selected = page ? rows.results.slice(0, PAGE_SIZE) : rows.results;
    const items = selected.map(row => ({ id: row.id, productId: row.product_id,
        color: row.color, createdAt: new Date(row.finalized_at).toISOString() }));
    const last = selected.at(-1);
    const nextCursor = page && rows.results.length > PAGE_SIZE && last
        ? `v1.${String(last.finalized_at)}.${last.id}` : null;
    return Response.json(page ? { items, nextCursor } : items, { headers });
}
