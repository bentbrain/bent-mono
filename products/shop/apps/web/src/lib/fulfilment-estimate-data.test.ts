import { beforeEach, expect, it, vi } from "vitest";
import { getCachedFulfilmentEstimate } from "./fulfilment-estimate-data";

const mocks = vi.hoisted(() => ({ production: vi.fn(), delivery: vi.fn(), life: vi.fn(), tag: vi.fn() }));
vi.mock("next/cache", () => ({ cacheLife: mocks.life, cacheTag: mocks.tag }));
vi.mock("@/server/fulfilment-estimates", () => ({ loadProductionEstimate: mocks.production, loadStandardDeliveryEstimate: mocks.delivery }));
beforeEach(() => vi.resetAllMocks());

it("bounds successful estimates to two hours with an hourly background refresh", async () => {
  const range = { minimumBusinessDays: 3, maximumBusinessDays: 5 };
  mocks.production.mockResolvedValue(range);
  mocks.delivery.mockResolvedValue(range);
  expect(await getCachedFulfilmentEstimate("staple-tee")).toEqual({ production: range, standardDelivery: range });
  expect(mocks.life.mock.calls).toEqual([
    [{ stale: 300, revalidate: 3_600, expire: 7_200 }], [{ stale: 300, revalidate: 3_600, expire: 7_200 }],
  ]);
  expect(mocks.tag.mock.calls).toEqual([["fulfilment-estimates"], ["fulfilment-estimates"]]);
});

it("retries an unavailable optional estimate within a minute instead of caching failure for hours", async () => {
  mocks.production.mockResolvedValue(undefined);
  mocks.delivery.mockResolvedValue(undefined);
  expect(await getCachedFulfilmentEstimate("cotton-tote")).toEqual({});
  expect(mocks.delivery).toHaveBeenCalledWith("cotton-tote");
  expect(mocks.life.mock.calls).toEqual([
    [{ stale: 0, revalidate: 30, expire: 60 }], [{ stale: 0, revalidate: 30, expire: 60 }],
  ]);
});
