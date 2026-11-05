// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductProjectionPreview } from "@/components/product-projection-preview";
const mocks = vi.hoisted(() => ({
    createConfiguredProductFamily: vi.fn(),
    routerReplace: vi.fn(),
}));
vi.mock("@/client/product-api", () => ({
    createConfiguredProductFamily: mocks.createConfiguredProductFamily,
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace: mocks.routerReplace }),
}));
afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
});
describe("ProductProjectionPreview", () => {
    it("prepares both products and hands an existing projection URL to the shared product page", async () => {
        vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
        mocks.createConfiguredProductFamily.mockResolvedValueOnce([
            {
                baseProductId: "a51b7acf-77e9-4762-83c4-62d96dd8942c",
                id: "shirt-product",
            },
            {
                baseProductId: "97b629d7-1d3b-4d2a-a586-537168141e97",
                id: "tote-product",
            },
        ]);
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });
        act(() => {
            root.render(<QueryClientProvider client={queryClient}>
          <ProductProjectionPreview designId="design-1" slug="cotton-tote"/>
        </QueryClientProvider>);
        });
        await act(async () => {
            await vi.waitFor(() => {
                expect(mocks.routerReplace).toHaveBeenCalledWith("/product/tote-product");
            });
        });
        expect(mocks.createConfiguredProductFamily).toHaveBeenCalledOnce();
        expect(mocks.createConfiguredProductFamily).toHaveBeenCalledWith({
            baseProductIds: [
                "a51b7acf-77e9-4762-83c4-62d96dd8942c",
                "97b629d7-1d3b-4d2a-a586-537168141e97",
            ],
            designId: "design-1",
        });
        expect(container.textContent).not.toContain("Automatic product projection");
        act(() => {
            root.unmount();
        });
    });
});
