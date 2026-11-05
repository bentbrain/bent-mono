import { describe, expect, it } from "vitest";

import {
  CONTENT_DECLARATION_VERSION,
  contentDeclarationCookieOptions,
  signContentDeclaration,
  verifyContentDeclaration,
} from "@/server/content-declaration-core";

describe("content declaration", () => {
  it("signs one declaration version for one anonymous owner", async () => {
    const declaration = await signContentDeclaration("owner-a", "secret-a");

    expect(declaration.startsWith(`${CONTENT_DECLARATION_VERSION}.`)).toBe(true);
    await expect(verifyContentDeclaration(declaration, "owner-a", "secret-a")).resolves.toBe(true);
    await expect(verifyContentDeclaration(declaration, "owner-b", "secret-a")).resolves.toBe(false);
    await expect(verifyContentDeclaration(declaration, "owner-a", "secret-b")).resolves.toBe(false);
  });

  it("rejects a changed or obsolete declaration", async () => {
    const declaration = await signContentDeclaration("owner-a", "secret-a");
    const changed = `${declaration.slice(0, -1)}${declaration.endsWith("A") ? "B" : "A"}`;

    await expect(verifyContentDeclaration(changed, "owner-a", "secret-a")).resolves.toBe(false);
    await expect(verifyContentDeclaration("portrait-v0.invalid", "owner-a", "secret-a")).resolves.toBe(false);
  });

  it("uses a host-only hardened cookie", () => {
    expect(contentDeclarationCookieOptions).toEqual({
      httpOnly: true,
      maxAge: 31_536_000,
      path: "/",
      sameSite: "lax",
      secure: true,
    });
  });
});
