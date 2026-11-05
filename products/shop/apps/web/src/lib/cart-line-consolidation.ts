import {
  CartIntegrityError,
  cartLineForUpdate,
  MAX_LINE_QUANTITY,
  persistedProductId,
  rebuildLineAttributes,
  type CartSnapshot,
  type VerifiedUpdateRequest,
} from "@/lib/cart-integrity";

// Use the final requested variants, not client-supplied attributes or labels.
// Capabilities are quantity-bound and renewed after this plan is validated.
export function consolidateVariantUpdates(
  cart: CartSnapshot,
  lines: VerifiedUpdateRequest["lines"],
): VerifiedUpdateRequest["lines"] {
  const updates = new Map<string, VerifiedUpdateRequest["lines"][number]>();
  for (const line of lines) {
    cartLineForUpdate(cart, line.id);
    if (updates.has(line.id)) {
      throw new CartIntegrityError("A cart line can only be updated once.");
    }
    updates.set(line.id, line);
  }

  const finalLines = cart.lines.map((current) => {
    const update = updates.get(current.id);
    const merchandiseId = update?.merchandiseId ?? current.merchandiseId;
    const sellingPlanId = update?.sellingPlanId === undefined
      ? current.sellingPlanId
      : update.sellingPlanId ?? undefined;
    return {
      current,
      merchandiseId,
      sellingPlanId,
      quantity: update?.quantity ?? current.quantity,
      changed: merchandiseId !== current.merchandiseId || sellingPlanId !== current.sellingPlanId,
    };
  });
  const groups = new Map<string, typeof finalLines>();
  for (const line of finalLines) {
    if (line.quantity <= 0 || !line.merchandiseId) continue;
    let productId: string;
    try {
      productId = persistedProductId(line.current.attributes);
    } catch {
      // Unrelated invalid lines must not prevent customers removing them.
      continue;
    }
    const attributes = rebuildLineAttributes(line.current.attributes, [])
      .map(({ key, value }) => [key, value])
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const key = JSON.stringify([productId, line.merchandiseId, line.sellingPlanId, attributes]);
    const group = groups.get(key) ?? [];
    group.push(line);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    if (group.length < 2 || !group.some(({ changed }) => changed)) continue;
    const survivor = group.find(({ changed }) => !changed) ?? group[0];
    if (!survivor) continue;
    const quantity = group.reduce((total, line) => total + line.quantity, 0);
    if (quantity > MAX_LINE_QUANTITY) {
      throw new CartIntegrityError("The cart line has reached its quantity limit.");
    }
    updates.set(survivor.current.id, {
      attributes: [],
      id: survivor.current.id,
      merchandiseId: survivor.merchandiseId,
      quantity,
      sellingPlanId: survivor.sellingPlanId ?? null,
    });
    for (const line of group) {
      if (line === survivor) continue;
      updates.set(line.current.id, { attributes: [], id: line.current.id, quantity: 0 });
    }
  }
  return [...updates.values()];
}
