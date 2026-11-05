import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/content-declaration/route";
import {
  CONTENT_DECLARATION_COOKIE,
  CONTENT_DECLARATION_FIELD,
} from "@/server/content-declaration-core";

vi.mock("@/env", () => ({
  env: { FOREVER_TEE_API_SHARED_SECRET: "test-shared-secret" },
}));

const mocks = vi.hoisted(() => ({
  anonymousOwner: vi.fn(() => Promise.resolve({ ownerId: "owner-id" })),
}));

vi.mock("@/server/anonymous-session", () => ({
  anonymousOwner: mocks.anonymousOwner,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("content declaration route", () => {
  it("returns a no-content acknowledgement for SPA submissions", async () => {
    const response = await POST(declarationRequest({ acceptsJson: true }));

    expect(response.status).toBe(204);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toContain(
      `${CONTENT_DECLARATION_COOKIE}=portrait-v1.`,
    );
  });

  it("keeps the redirect fallback for submissions before hydration", async () => {
    const response = await POST(declarationRequest({ acceptsJson: false }));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://example.com/create/camera",
    );
  });

  it("rejects an omitted declaration without navigating the SPA", async () => {
    const response = await POST(declarationRequest({
      accepted: false,
      acceptsJson: true,
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "The content declaration is required.",
    });
    expect(mocks.anonymousOwner).not.toHaveBeenCalled();
  });
});

function declarationRequest({
  accepted = true,
  acceptsJson,
}: {
  accepted?: boolean;
  acceptsJson: boolean;
}) {
  const form = new FormData();
  if (accepted) form.set(CONTENT_DECLARATION_FIELD, "accepted");
  const headers = new Headers({ origin: "https://example.com" });
  if (acceptsJson) headers.set("accept", "application/json");
  return new Request("https://example.com/api/content-declaration", {
    body: form,
    headers,
    method: "POST",
  });
}
