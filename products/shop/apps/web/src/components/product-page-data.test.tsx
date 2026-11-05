import { beforeEach, expect, it, vi } from "vitest";
import { ProductPageData } from "./product-page-content";
const mocks = vi.hoisted(() => ({ record: vi.fn(), family: vi.fn(), catalogue: vi.fn(), estimate: vi.fn() }));
vi.mock("next/cache", () => ({ io: () => Promise.resolve() }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("Not found"); } }));
vi.mock("@/lib/product-record-data", () => ({ getCachedProductRecord: mocks.record, getCachedProductFamilyRecords: mocks.family }));
vi.mock("@/lib/product-data", () => ({ getForeverTeeProduct: mocks.catalogue }));
vi.mock("@/lib/fulfilment-estimate-data", () => ({ getCachedFulfilmentEstimate: mocks.estimate }));
vi.mock("@/components/configured-product-family", () => ({ ConfiguredProductFamily: () => null }));
vi.mock("@/components/default-product-family", () => ({ DefaultProductFamily: () => null }));
vi.mock("@/components/route-skeletons", () => ({ ProductPageSkeleton: () => null }));
const record = {
    id: "configured-shirt", baseProductId: "a51b7acf-77e9-4762-83c4-62d96dd8942c",
    designId: "design", designRevisionId: "revision", defaultColor: "White", shopifyHandle: "bent-shirt",
};
const props = { params: Promise.resolve({ id: record.id }), searchParams: Promise.resolve({}),
    familyQueryParamName: undefined, syncUrl: true, syncVariantUrl: true, variantPathname: undefined };
const delayed = <T,>(value: T) => new Promise<T>(resolve => setTimeout(() => { resolve(value); }, 50));
beforeEach(() => { vi.resetAllMocks(); });
it("loads a configured family without a separate anchor request", async () => {
    mocks.record.mockImplementation(() => delayed(record));
    mocks.family.mockImplementation(() => delayed([record, { ...record, id: "configured-tote", baseProductId: "97b629d7-1d3b-4d2a-a586-537168141e97", shopifyHandle: "cotton-tote" }]));
    mocks.catalogue.mockImplementation(() => delayed({}));
    const start = performance.now();
    await ProductPageData(props);
    console.info("Product data benchmark", JSON.stringify({ elapsedMs: Math.round(performance.now() - start), recordReads: mocks.record.mock.calls.length, familyReads: mocks.family.mock.calls.length, catalogueReads: mocks.catalogue.mock.calls.length, providerDelayMs: 50 }));
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.family).toHaveBeenCalledOnce();
    expect(mocks.catalogue).toHaveBeenCalledTimes(2);
});
it("does not render a family whose requested anchor has been removed", async () => {
    mocks.family.mockResolvedValue([{ ...record, id: "other-product" }]);
    await expect(ProductPageData(props)).rejects.toThrow("Not found");
    expect(mocks.catalogue).not.toHaveBeenCalled();
});
it.each([true, false])("prepares product controls without awaiting optional estimates, configured=%s", async (configured) => {
    mocks.family.mockResolvedValue([{ ...record, designId: configured ? record.designId : null }]);
    mocks.catalogue.mockResolvedValue({});
    mocks.estimate.mockReturnValue(Promise.withResolvers<undefined>().promise);
    const result = await ProductPageData(props);
    expect(result).toBeTruthy();
    expect(mocks.estimate).not.toHaveBeenCalled();
});
