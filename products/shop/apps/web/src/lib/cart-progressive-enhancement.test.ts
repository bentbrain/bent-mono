import { parseCartRequest } from "@shopify/hydrogen";
import { describe, expect, it } from "vitest";

interface NativeCartCase {
  expectedIntent: "remove" | "update";
  expectedQuantity?: number;
  intent: string;
  quantity: string;
}

const nativeCartCases: NativeCartCase[] = [
  { intent: "set", quantity: "4", expectedIntent: "update", expectedQuantity: 4 },
  { intent: "increase", quantity: "2", expectedIntent: "update", expectedQuantity: 3 },
  { intent: "decrease", quantity: "2", expectedIntent: "update", expectedQuantity: 1 },
  { intent: "decrease", quantity: "1", expectedIntent: "remove" },
  { intent: "remove", quantity: "2", expectedIntent: "remove" },
];

describe("native cart forms", () => {
  it.each(nativeCartCases)(
    "parses the $intent intent without JavaScript",
    async ({ intent, quantity, expectedIntent, expectedQuantity }) => {
      const body = new URLSearchParams({
        intent,
        lineId: "gid://shopify/CartLine/line-id",
        quantity,
      });
      const request = new Request("https://example.com/api/cart", {
        body,
        method: "POST",
      });

      const result = await parseCartRequest(request);

      expect(result.action.intent).toBe(expectedIntent);
      if (result.action.intent === "update") {
        expect(result.action.lines[0]?.quantity).toBe(expectedQuantity);
      } else if (result.action.intent === "remove") {
        expect(result.action.lineIds).toEqual([
          "gid://shopify/CartLine/line-id",
        ]);
      } else {
        throw new Error(`Unexpected cart intent: ${result.action.intent}`);
      }
    },
  );
});
