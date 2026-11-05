// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CartVariantSelectors } from "@/components/cart-variant-selectors";

interface CartUpdateInput {
  lines: { merchandiseId: string }[];
}

interface CartUpdateResult {
  userErrors: { message: string }[];
}

interface MockSelectProps {
  children: ReactNode;
  onValueChange: (value: string) => void;
  value: string;
}

interface MockSelectItemProps {
  children: ReactNode;
  disabled?: boolean;
  value: string;
}

const actionMocks = vi.hoisted(() => ({
  updateCart: vi.fn<
    (input: CartUpdateInput) => Promise<CartUpdateResult>
  >(),
}));

vi.mock("@/lib/cart-actions", () => ({
  waitForCartActions: () =>
    Promise.resolve({
      updateCart: actionMocks.updateCart,
    }),
}));

vi.mock("@/components/ui/select", () => ({
  Select({ children, onValueChange, value }: MockSelectProps) {
    return (
      <select
        value={value}
        onChange={(event) => {
          onValueChange(event.currentTarget.value);
        }}
      >
        {children}
      </select>
    );
  },
  SelectContent({ children }: { children: ReactNode }) {
    return children;
  },
  SelectItem({ children, disabled, value }: MockSelectItemProps) {
    return <option value={value} disabled={disabled}>{children}</option>;
  },
  SelectTrigger() {
    return null;
  },
  SelectValue() {
    return null;
  },
}));

const options = [
  { name: "Color", optionValues: [{ name: "Black" }, { name: "White" }] },
  {
    name: "Size",
    optionValues: [
      { name: "S" },
      { name: "XS" },
      { name: "M" },
      { name: "L" },
    ],
  },
];

const variants = [
  variant("black-xs", "Black", "XS"),
  variant("black-s", "Black", "S"),
  variant("black-m", "Black", "M"),
  variant("black-l", "Black", "L"),
  variant("white-xs", "White", "XS"),
  variant("white-s", "White", "S"),
  variant("white-m", "White", "M"),
  variant("white-l", "White", "L"),
];

describe("CartVariantSelectors", () => {
  beforeEach(() => {
    actionMocks.updateCart.mockReset();
    actionMocks.updateCart.mockResolvedValue({ userErrors: [] });
  });

  it("combines rapid option changes against the latest optimistic selection", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      act(() => {
        root.render(
          <CartVariantSelectors
            attributes={[]}
            lineId="line-one"
            merchandiseId="black-s"
            options={options}
            pending={false}
            quantity={1}
            selectedOptions={[
              { name: "Color", value: "Black" },
              { name: "Size", value: "S" },
            ]}
            title="bent.shop"
            variants={variants}
          />,
        );
      });

      const selects = container.querySelectorAll<HTMLSelectElement>("select");
      const color = selects[0];
      const size = selects[1];
      if (!color || !size) throw new Error("Expected color and size controls.");

      await act(async () => {
        color.value = "White";
        color.dispatchEvent(new Event("change", { bubbles: true }));
        size.value = "M";
        size.dispatchEvent(new Event("change", { bubbles: true }));
        await Promise.resolve();
      });

      expect(actionMocks.updateCart).toHaveBeenCalledTimes(2);
      expect(
        actionMocks.updateCart.mock.calls[0]?.[0].lines[0]?.merchandiseId,
      ).toBe("white-s");
      expect(
        actionMocks.updateCart.mock.calls[1]?.[0].lines[0]?.merchandiseId,
      ).toBe("white-m");
    } finally {
      act(() => { root.unmount(); });
      container.remove();
    }
  });

  it("presents apparel sizes in size order even when Shopify returns S first", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      act(() => {
        root.render(
          <CartVariantSelectors
            attributes={[]}
            lineId="line-one"
            merchandiseId="black-s"
            options={options}
            pending={false}
            quantity={1}
            selectedOptions={[
              { name: "Color", value: "Black" },
              { name: "Size", value: "S" },
            ]}
            title="bent.shop"
            variants={variants}
          />,
        );
      });

      const size = container.querySelectorAll<HTMLSelectElement>("select")[1];
      if (!size) throw new Error("Expected a size control.");

      expect([...size.options].map((option) => option.value)).toEqual([
        "XS",
        "S",
        "M",
        "L",
      ]);
    } finally {
      act(() => { root.unmount(); });
      container.remove();
    }
  });

  it("keeps option names accessible without rendering visible labels", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      act(() => {
        root.render(
          <CartVariantSelectors
            attributes={[]}
            lineId="line-one"
            merchandiseId="black-s"
            options={options}
            pending={false}
            quantity={1}
            selectedOptions={[
              { name: "Color", value: "Black" },
              { name: "Size", value: "S" },
            ]}
            title="bent.shop"
            variants={variants}
          />,
        );
      });

      expect(container.textContent).not.toContain("Color");
      expect(container.textContent).not.toContain("Size");
    } finally {
      act(() => { root.unmount(); });
      container.remove();
    }
  });
});

function variant(id: string, color: string, size: string) {
  return {
    availableForSale: true,
    id,
    selectedOptions: [
      { name: "Color", value: color },
      { name: "Size", value: size },
    ],
  };
}
