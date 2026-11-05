import { describe, expect, it } from "vitest";
import { runOperationsCommand } from "./operations-client";
const CONFIGURATION = {
    operationsSecret: "operations-secret",
    serviceSecret: "service-secret",
    workerUrl: "https://api.example.com",
};
describe("operations client", () => {
    it("pauses sales and verifies the resulting status", async () => {
        const requests: Request[] = [];
        const fetcher: typeof fetch = (input, init) => {
            const request = new Request(input, init);
            requests.push(request);
            if (request.method === "PUT") {
                return Promise.resolve(Response.json({
                    message: "Orders are temporarily paused. Please check back soon.",
                    paused: true,
                    reason: "Launch qualification is incomplete.",
                    updatedAt: "2026-08-31T00:00:00.000Z",
                }));
            }
            return Promise.resolve(Response.json({
                message: "Orders are temporarily paused. Please check back soon.",
                paused: true,
                reason: "Launch qualification is incomplete.",
                updatedAt: "2026-08-31T00:00:00.000Z",
            }));
        };
        const result = await runOperationsCommand({
            ...CONFIGURATION,
            action: "pause-sales",
            reason: "Launch qualification is incomplete.",
        }, fetcher);
        expect(result).toMatchObject({
            paused: true,
            reason: "Launch qualification is incomplete.",
        });
        expect(requests).toHaveLength(2);
        expect(requests[0]?.headers.get("x-bent-shirt-operations-secret"))
            .toBe("operations-secret");
        expect(requests[1]?.headers.get("x-forever-tee-service-secret"))
            .toBe("service-secret");
    });
    it("validates refresh responses", async () => {
        const fetcher: typeof fetch = () => Promise.resolve(Response.json({
            products: [
                { baseProductSlug: "staple-tee", variantCount: 18 },
                { baseProductSlug: "cotton-tote", variantCount: 2 },
            ],
        }));
        await expect(runOperationsCommand({
            ...CONFIGURATION,
            action: "refresh-variant-mapping",
        }, fetcher)).resolves.toMatchObject({
            products: [
                { baseProductSlug: "staple-tee", variantCount: 18 },
                { baseProductSlug: "cotton-tote", variantCount: 2 },
            ],
        });
    });
    it("reconciles print assets through the authenticated operation", async () => {
        let request: Request | undefined;
        const fetcher: typeof fetch = (input, init) => {
            request = new Request(input, init);
            return Promise.resolve(Response.json({
                productsFailed: 0,
                productsReconciled: 1,
            }));
        };
        await expect(runOperationsCommand({
            ...CONFIGURATION,
            action: "refresh-print-assets",
            configuredProductId: "d2dd07c1-dbbf-4d1a-8df7-9c43b4a7dfc4",
        }, fetcher)).resolves.toEqual({
            productsFailed: 0,
            productsReconciled: 1,
        });
        expect(request?.url).toBe("https://api.example.com/v2/internal/operations/print-assets-refresh?configuredProductId=" + "d2dd07c1-dbbf-4d1a-8df7-9c43b4a7dfc4");
        expect(request?.headers.get("x-bent-shirt-operations-secret"))
            .toBe("operations-secret");
    });
    it("rejects non-HTTPS Worker URLs", async () => {
        await expect(runOperationsCommand({
            ...CONFIGURATION,
            action: "read-sales-status",
            workerUrl: "http://api.example.com",
        })).rejects.toThrow("The operations command configuration is invalid.");
    });
    it("reports Worker API errors without exposing credentials", async () => {
        const fetcher: typeof fetch = () => Promise.resolve(Response.json({
            error: {
                code: "UNAUTHORIZED",
                message: "Operations authentication is required.",
            },
        }, { status: 401 }));
        await expect(runOperationsCommand({
            ...CONFIGURATION,
            action: "refresh-catalogue",
        }, fetcher)).rejects.toThrow("UNAUTHORIZED: Operations authentication is required.");
    });
});
