import { protectedConfig } from "../../../../scripts/protected-config.mjs";
// @vitest-environment happy-dom
import type { AnonymousDesignDraftDto, SavedDesignPageDto } from "@forever-tee/contracts";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SavedDesigns } from "./saved-designs";
import { DeleteDesign } from "./delete-design";
import { DesignEditorMobileContent } from "./design-editor-mobile-content";
const mocks = vi.hoisted(() => ({
    getDesign: vi.fn<() => Promise<AnonymousDesignDraftDto>>(),
    getSavedDesigns: vi.fn<(cursor: string | null, signal?: AbortSignal) => Promise<SavedDesignPageDto>>(),
    deleteDesign: vi.fn<() => Promise<{
        id: string;
        productIds: string[];
    }>>(),
    replace: vi.fn(),
}));
vi.mock("@/client/design-api", () => mocks);
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock("@/client/product-availability", () => ({ getBaseProductAvailability: () => Promise.resolve({ available: true }) }));
vi.mock("./shirt-editor", () => ({ ShirtEditor: () => <div>Editable canvas</div> }));
vi.mock("./mobile-only-gate", () => ({ MobileOnlyGate: ({ children }: {
        children: ReactNode;
    }) => children }));
vi.mock("next/link", () => ({ default: ({ children, href, prefetch, ...props }: ComponentProps<"a"> & {
        prefetch?: boolean;
    }) => <a {...props} href={href} data-prefetch={String(prefetch)}>{children}</a> }));
const DESIGN: AnonymousDesignDraftDto = {
    id: protectedConfig("resource_83abf907850d"), finalized: true,
    version: 3, status: "ready", contentType: "image/png", artworkRevision: null,
    artworkUrl: "/artwork", createdAt: "2026-09-03T01:00:00.000Z", updatedAt: "2026-09-03T01:00:00.000Z",
    settings: { cropX: 0.5, cropY: 0.5, cropZoom: 1, placementX: 0.3, placementY: 0.3, placementWidth: 0.2, depth: 5 },
};
let root: Root | undefined;
let container: HTMLDivElement;
let queryClient: QueryClient;
beforeEach(() => {
    notifyManager.setScheduler(queueMicrotask);
    mocks.getSavedDesigns.mockReset();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    mocks.getDesign.mockResolvedValue(DESIGN);
});
afterEach(() => {
    act(() => { root?.unmount(); });
    queryClient.clear();
    notifyManager.setScheduler(callback => setTimeout(callback, 0));
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});
async function mount(children: ReactNode) {
    root = createRoot(container);
    act(() => { root?.render(<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>); });
    await settle();
}
async function settle() {
    await act(async () => { await Promise.resolve(); });
}
function button(text: string) {
    const result = Array.from(document.querySelectorAll("button")).find((candidate) => candidate.textContent === text);
    if (!result)
        throw new Error(`Missing ${text} button`);
    return result;
}
describe("saved designs", () => {
    it("links mockup tiles directly to their products", async () => {
        mocks.getSavedDesigns.mockResolvedValue({ items: [{ id: DESIGN.id, productId: "saved-product", color: "Black", createdAt: DESIGN.createdAt }], nextCursor: null });
        await mount(<SavedDesigns />);
        expect(container.querySelector("section")?.getAttribute("aria-label")).toBe("Products");
        expect(container.querySelector("a")?.getAttribute("href")).toBe("/product/saved-product");
        expect(container.querySelector("img")?.src).toContain("/api/configured-product-image/current/saved-product/black.webp");
        expect(container.querySelector("img")?.src).toContain("width=384");
        expect(container.querySelector("a")?.dataset["prefetch"]).toBe("false");
        act(() => { container.querySelector("a")?.focus(); });
        expect(container.querySelector("a")?.dataset["prefetch"]).toBe("true");
    });
    it("keeps creation available when empty and lets failed loads retry", async () => {
        mocks.getSavedDesigns.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ items: [], nextCursor: null });
        await mount(<SavedDesigns />);
        expect(container.querySelector('[role="alert"]')).not.toBeNull();
        act(() => { button("Try again").click(); });
        await settle();
        expect(container.querySelector('a[aria-label="Make your own"]')?.getAttribute("href")).toBe("/create");
    });
    it("retains featured products and creation while owned designs load or fail", async () => {
        const pending = Promise.withResolvers<SavedDesignPageDto>();
        mocks.getSavedDesigns.mockReturnValueOnce(pending.promise);
        await mount(<SavedDesigns featured={[{ slot: 3, productId: "featured", color: "White" }]}/>);
        expect(container.querySelector('a[aria-label="Open featured design 3"]')?.getAttribute("href")).toBe("/featured/featured");
        expect(container.querySelectorAll("a")).toHaveLength(2);
        act(() => { pending.reject(new Error("offline")); });
        await settle();
        expect(container.querySelector('[role="alert"]')?.textContent).toContain("couldn't be loaded");
        expect(container.querySelectorAll("a")).toHaveLength(2);
        expect(container.querySelector(".grid")?.lastElementChild?.getAttribute("href")).toBe("/create");
    });
    it("loads only on request, retains tiles on failure, and focuses the first appended tile", async () => {
        const first = { id: DESIGN.id, productId: "first", color: "White", createdAt: DESIGN.createdAt };
        const cursor = `v1.1700000000000.${DESIGN.id}`;
        mocks.getSavedDesigns.mockResolvedValueOnce({ items: [first], nextCursor: cursor });
        await mount(<SavedDesigns />);
        expect(mocks.getSavedDesigns).toHaveBeenCalledTimes(1);
        const next = Promise.withResolvers<SavedDesignPageDto>();
        mocks.getSavedDesigns.mockReturnValueOnce(next.promise);
        act(() => { button("Load more").focus(); button("Load more").click(); });
        await settle();
        expect(button("Loading…").disabled).toBe(true);
        expect(container.querySelectorAll("a[data-saved-design]")).toHaveLength(1);
        act(() => { next.reject(new Error("offline")); });
        await settle();
        expect(container.querySelectorAll("a[data-saved-design]")).toHaveLength(1);
        expect(container.querySelector('[role="alert"]')?.textContent).toContain("More designs");
        mocks.getSavedDesigns.mockResolvedValueOnce({ items: [{ ...first, id: "second", productId: "second" }], nextCursor: null });
        act(() => { button("Try again").focus(); button("Try again").click(); });
        await settle();
        expect(container.querySelectorAll("a[data-saved-design]")).toHaveLength(2);
        expect(document.activeElement?.getAttribute("href")).toBe("/product/second");
        expect(container.querySelector("button")).toBeNull();
        expect(mocks.getSavedDesigns.mock.calls.map(call => call[0])).toEqual([null, cursor, cursor]);
    });
    it("resets the initial request after leaving a loaded history", async () => {
        const first = { id: DESIGN.id, productId: "first", color: "White", createdAt: DESIGN.createdAt };
        mocks.getSavedDesigns.mockResolvedValueOnce({ items: [first], nextCursor: `v1.1700000000000.${DESIGN.id}` })
            .mockResolvedValueOnce({ items: [{ ...first, id: "second", productId: "second" }], nextCursor: null })
            .mockResolvedValueOnce({ items: [first], nextCursor: null });
        await mount(<SavedDesigns />);
        act(() => { button("Load more").click(); });
        await settle();
        act(() => { root?.render(<QueryClientProvider client={queryClient}><div>Another page</div></QueryClientProvider>); });
        await settle();
        act(() => { root?.render(<QueryClientProvider client={queryClient}><SavedDesigns /></QueryClientProvider>); });
        await settle();
        expect(mocks.getSavedDesigns.mock.calls.map(call => call[0])).toEqual([null, `v1.1700000000000.${DESIGN.id}`, null]);
        expect(container.querySelectorAll("a[data-saved-design]")).toHaveLength(1);
    });
    it("keeps focus in the gallery when the remaining page was deleted", async () => {
        mocks.getSavedDesigns.mockResolvedValueOnce({ items: [{ id: DESIGN.id, productId: "last", color: "White", createdAt: DESIGN.createdAt }],
            nextCursor: `v1.1700000000000.${DESIGN.id}` }).mockResolvedValueOnce({ items: [], nextCursor: null });
        await mount(<SavedDesigns />);
        act(() => { button("Load more").focus(); button("Load more").click(); });
        await settle();
        expect(document.activeElement?.getAttribute("href")).toBe("/product/last");
        expect(container.querySelector("button")).toBeNull();
    });
    it("redirects completed drafts without mounting the editor", async () => {
        await mount(<DesignEditorMobileContent cameraLaunch={false} id={DESIGN.id}/>);
        expect(mocks.replace).toHaveBeenCalledWith("/create");
        expect(container.textContent).not.toContain("Editable canvas");
    });
    it("waits for a fresh ownership read before reopening a cached draft", async () => {
        queryClient.setQueryData(["design", DESIGN.id], { ...DESIGN, finalized: false });
        await mount(<DesignEditorMobileContent cameraLaunch={false} id={DESIGN.id}/>);
        expect(mocks.getDesign).toHaveBeenCalledOnce();
        expect(mocks.replace).toHaveBeenCalledWith("/create");
        expect(container.textContent).not.toContain("Editable canvas");
    });
    it("hides deletion for a different visitor", async () => {
        mocks.getDesign.mockRejectedValueOnce(new Error("not found"));
        await mount(<DeleteDesign designId={DESIGN.id}/>);
        expect(container.querySelector("button")).toBeNull();
    });
    it("requires confirmation, preserves the dialog on failure, then returns to the gallery", async () => {
        const navigate = vi.spyOn(window.location, "replace").mockImplementation(() => undefined);
        mocks.deleteDesign.mockRejectedValueOnce(new Error("offline"))
            .mockResolvedValueOnce({ id: DESIGN.id, productIds: [] });
        await mount(<DeleteDesign designId={DESIGN.id}/>);
        act(() => { button("Delete").click(); });
        expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
        expect(mocks.deleteDesign).not.toHaveBeenCalled();
        act(() => { button("cancel").click(); });
        expect(mocks.deleteDesign).not.toHaveBeenCalled();
        act(() => { button("Delete").click(); });
        act(() => { button("delete").click(); });
        await settle();
        expect(document.querySelector('[role="alert"]')?.textContent).toContain("couldn't be deleted");
        expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
        act(() => { button("delete").click(); });
        await settle();
        expect(navigate).toHaveBeenCalledWith("/");
    });
});
