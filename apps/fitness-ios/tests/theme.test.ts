import { describe, expect, test } from "bun:test";
import { designTokens } from "@bent/design-tokens";

const css = await Bun.file(new URL("../global.css", import.meta.url)).text();

/** The value a colour token has in the light or dark block of global.css. */
function token(variant: "light" | "dark", name: string) {
  const block = new RegExp(`@variant ${variant} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  return new RegExp(`--color-${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim();
}

describe("theme", () => {
  test("the primary colour is the shared bent.build accent in light and dark", () => {
    expect(token("light", "primary")).toBe(designTokens.accentLight);
    expect(token("dark", "primary")).toBe(designTokens.accentDark);
  });

  test("light and dark define the same tokens", () => {
    const names = (variant: "light" | "dark") =>
      [...(new RegExp(`@variant ${variant} \\{([^}]*)\\}`).exec(css)?.[1] ?? "").matchAll(/--color-([a-z-]+):/g)]
        .map((match) => match[1])
        .sort();
    expect(names("dark")).toEqual(names("light"));
    expect(names("light").length).toBeGreaterThan(20);
  });
});
