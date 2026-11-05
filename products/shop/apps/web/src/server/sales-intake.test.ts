import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("@/env", () => ({
  env: {
    FOREVER_TEE_API_SHARED_SECRET: "service-secret",
    FOREVER_TEE_API_URL: "https://api.example",
  },
}));
vi.mock("undici", () => ({ fetch: mocks.fetch }));

import {
  assertSalesIntakeOpen,
  SalesIntakeDependencyError,
  SalesIntakePausedError,
} from "@/server/sales-intake";

describe("sales intake client", () => {
  beforeEach(() => mocks.fetch.mockReset());

  it("allows intake only from a valid open response", async () => {
    mocks.fetch.mockResolvedValue(Response.json({ paused: false }));

    await expect(assertSalesIntakeOpen()).resolves.toBeUndefined();
    expect(mocks.fetch).toHaveBeenCalledWith(
      new URL("https://api.example/v2/internal/sales-intake"),
      expect.objectContaining({
        headers: {
          "x-forever-tee-service-secret": "service-secret",
        },
        redirect: "error",
      }),
    );
  });

  it("reports a deliberate pause with the customer message", async () => {
    mocks.fetch.mockResolvedValue(Response.json({ paused: true }));
    await expect(assertSalesIntakeOpen()).rejects.toBeInstanceOf(
      SalesIntakePausedError,
    );
  });

  it("fails closed when the Worker response is invalid", async () => {
    mocks.fetch.mockResolvedValue(Response.json({ available: true }));
    await expect(assertSalesIntakeOpen()).rejects.toBeInstanceOf(
      SalesIntakeDependencyError,
    );
  });
});
