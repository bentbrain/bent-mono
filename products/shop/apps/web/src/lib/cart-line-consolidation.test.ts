import { describe, expect, it } from "vitest";

import { type CartLineSnapshot, type CartSnapshot, type VerifiedUpdateRequest } from "@/lib/cart-integrity";
import { consolidateVariantUpdates } from "@/lib/cart-line-consolidation";

const medium: CartLineSnapshot = {
  id: "medium", merchandiseId: "black-m", quantity: 2,
  attributes: [{ key: "_productId", value: "shirt-design-one" }, { key: "_lineCapability", value: "old-m" }],
};
const large: CartLineSnapshot = {
  ...medium, id: "large", merchandiseId: "black-l", quantity: 3,
  attributes: [{ key: "_productId", value: "shirt-design-one" }, { key: "_lineCapability", value: "old-l" }],
};
const sizeChange: VerifiedUpdateRequest["lines"] = [
  { id: "large", merchandiseId: "black-m", quantity: 3, attributes: [] },
];
function snapshot(lines: readonly CartLineSnapshot[] = [medium, large]): CartSnapshot {
  return { id: "cart", lines, totalQuantity: lines.reduce((total, line) => total + line.quantity, 0) };
}

describe("consolidateVariantUpdates", () => {
  it("keeps the existing matching line and sums quantities despite different capabilities", () => {
    expect(consolidateVariantUpdates(snapshot(), sizeChange)).toEqual([
      { id: "large", quantity: 0, attributes: [] },
      { id: "medium", merchandiseId: "black-m", quantity: 5, sellingPlanId: null, attributes: [] },
    ]);
  });

  const distinctLines: [string, CartLineSnapshot][] = [
    ["different colour", { ...medium, merchandiseId: "white-m" }],
    ["different design", { ...medium, attributes: [{ key: "_productId", value: "shirt-design-two" }] }],
    ["different base product", { ...medium, merchandiseId: "tote", attributes: [{ key: "_productId", value: "tote-design-one" }] }],
    ["different purchase plan", { ...medium, sellingPlanId: "plan-one" }],
    ["different custom properties", { ...medium, attributes: [...medium.attributes, { key: "Gift note", value: "Keep me" }] }],
    ["missing product identity", { ...medium, attributes: [] }],
    ["ambiguous product identity", { ...medium, attributes: [...medium.attributes, { key: "_productId", value: "another" }] }],
  ];
  it.each(distinctLines)("preserves a line with %s", (_name, distinct) => {
    expect(consolidateVariantUpdates(snapshot([distinct, large]), sizeChange)).toEqual(sizeChange);
  });

  it("ignores forged incoming product identity and preserves matching custom properties", () => {
    const gift = { key: "Gift note", value: "Keep me" };
    const lines = [
      { ...medium, attributes: [...medium.attributes, gift] },
      { ...large, attributes: [gift, ...large.attributes] },
    ];
    const update = { id: "large", merchandiseId: "black-m", quantity: 3, attributes: [{ key: "_productId", value: "forged" }] };
    expect(consolidateVariantUpdates(snapshot(lines), [update]))
      .toContainEqual({ id: "medium", merchandiseId: "black-m", quantity: 5, sellingPlanId: null, attributes: [] });
  });

  it("uses every final requested quantity and merges all matching lines", () => {
    const cart = snapshot([medium, large, { ...medium, id: "third", quantity: 1 }]);
    const planned = consolidateVariantUpdates(cart, [
      ...sizeChange, { id: "medium", quantity: 4, attributes: [] },
    ]);
    expect(planned.find(({ id }) => id === "medium")?.quantity).toBe(8);
    expect(planned.filter(({ quantity }) => quantity === 0).map(({ id }) => id)).toEqual(["large", "third"]);
  });

  it("does not merge a line being changed away or removed in the same request", () => {
    for (const other of [
      { id: "medium", merchandiseId: "black-l", quantity: 2, attributes: [] },
      { id: "medium", quantity: 0, attributes: [] },
    ]) {
      const lines = [...sizeChange, other];
      expect(consolidateVariantUpdates(snapshot(), lines)).toEqual(lines);
    }
  });

  it("does not change duplicate lines on an unrelated quantity update", () => {
    const lines = [{ id: "medium", quantity: 1, attributes: [] }];
    expect(consolidateVariantUpdates(snapshot([medium, { ...medium, id: "other" }]), lines)).toEqual(lines);
  });

  it("rejects an over-limit merged line before mutation", () => {
    expect(() => consolidateVariantUpdates(snapshot([{ ...medium, quantity: 8 }, large]), sizeChange))
      .toThrow("quantity limit");
  });

  it("rejects duplicate or unowned update IDs instead of losing an update", () => {
    expect(() => consolidateVariantUpdates(snapshot(), [...sizeChange, ...sizeChange])).toThrow("only be updated once");
    expect(() => consolidateVariantUpdates(snapshot(), [{ id: "missing", attributes: [], quantity: 0 }])).toThrow("does not exist");
  });
});
