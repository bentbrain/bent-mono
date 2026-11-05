import type { BaseProductSlug } from "@forever-tee/contracts/product-projection";
import { describe, expect, it, vi } from "vitest";

import {
  loadFulfilmentEstimate,
  parsePrintProviderProductionEstimate,
} from "@/server/fulfilment-estimates";

type TestFetch = typeof globalThis.fetch;

const mocks = vi.hoisted(() => ({ fetch: vi.fn<TestFetch>() }));

vi.mock("@/env", () => ({
  env: {
    FOREVER_TEE_API_SHARED_SECRET: "service-secret",
    FOREVER_TEE_API_URL: "https://api.example",
  },
}));
vi.mock("undici", () => ({ fetch: mocks.fetch }));

describe("fulfilment estimates", () => {
  it("reads The Print Bar production range from Printify's status content", () => {
    expect(parsePrintProviderProductionEstimate(`
      <table><tbody>
        <tr><td data-title="Print Provider">Another provider</td><td data-title="Production time estimate">2-4 business days</td></tr>
        <tr><td data-title="Print Provider">The Print Bar</td><td data-title="Current status"><span>Production not affected</span></td><td data-title="Production time estimate">3-5 business days</td></tr>
      </tbody></table>
    `)).toEqual({ maximumBusinessDays: 5, minimumBusinessDays: 3 });
  });

  it("combines live Printify production status with the accepted catalogue delivery range", async () => {
    mocks.fetch.mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.startsWith("https://printify.com/")) {
        return Promise.resolve(Response.json([{
          content: {
            rendered: '<tr><td data-title="Print Provider">The Print Bar</td><td data-title="Production time estimate">3-5 business days</td></tr>',
          },
        }]));
      }
      return Promise.resolve(Response.json({
        variants: [
          {
            standardShippingToAustralia: {
              handlingDaysFrom: 3,
              handlingDaysTo: 6,
            },
          },
          {
            standardShippingToAustralia: {
              handlingDaysFrom: 4,
              handlingDaysTo: 7,
            },
          },
        ],
      }));
    });

    await expect(loadFulfilmentEstimate("staple-tee")).resolves.toEqual({
      production: { maximumBusinessDays: 5, minimumBusinessDays: 3 },
      standardDelivery: { maximumBusinessDays: 7, minimumBusinessDays: 3 },
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(requestUrl(mocks.fetch.mock.calls[1]?.[0])).toBe(
      "https://api.example/v2/internal/catalogue?baseProduct=staple-tee",
    );
    expect(mocks.fetch.mock.calls[1]?.[1]?.headers).toEqual({
      "x-forever-tee-service-secret": "service-secret",
    });
  });

  it("returns the provider-backed value that remains available", async () => {
    mocks.fetch.mockImplementation((input) => {
      if (requestUrl(input).startsWith("https://printify.com/")) {
        return Promise.resolve(new Response(null, { status: 503 }));
      }
      return Promise.resolve(Response.json({
        variants: [{
          standardShippingToAustralia: {
            handlingDaysFrom: 3,
            handlingDaysTo: 6,
          },
        }],
      }));
    });

    const slug: BaseProductSlug = "cotton-tote";
    await expect(loadFulfilmentEstimate(slug)).resolves.toEqual({
      standardDelivery: { maximumBusinessDays: 6, minimumBusinessDays: 3 },
    });
  });
});

function requestUrl(input: Parameters<TestFetch>[0]): string;
function requestUrl(input: Parameters<TestFetch>[0] | undefined): string | undefined;
function requestUrl(input: Parameters<TestFetch>[0] | undefined) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input?.url;
}
