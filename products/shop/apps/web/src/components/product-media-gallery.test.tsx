// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BaseProductSlug } from "@forever-tee/contracts/product-projection";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProductMediaGallery } from "@/components/product-media-gallery";
import { ProductFamily } from "@/components/product-family";

const lifestyleState = vi.hoisted(() => ({ready:false, listeners:new Set<() => void>()}));
const carouselState = vi.hoisted(() => ({reInit:(): void => {throw new Error("Carousel is not mounted.");}}));
const lifestyleQueries = vi.hoisted(() => vi.fn());
vi.mock("@/lib/use-lifestyle-image",async()=>{
  const {useSyncExternalStore}=await import("react");
  return {useLifestyleImage:()=>{
  lifestyleQueries();
  const ready=useSyncExternalStore(listener=>{
    lifestyleState.listeners.add(listener);
    return ()=>{lifestyleState.listeners.delete(listener);};
  },()=>lifestyleState.ready);
  return {data:ready
    ? {status:"ready",url:"/lifestyle.webp"} : {status:"unavailable"}};
}};});
// Supply carousel geometry-independent navigation; the gallery still owns all
// selection, product-switching and video lifecycle behaviour.
vi.mock("embla-carousel-react", async () => {
  const { useMemo } = await import("react");
  return {
    default: function useMockEmblaCarousel() { return useMemo(() => {
      let selected = 0;
      const listeners = new Map<string, Set<() => void>>();
      carouselState.reInit = () => { listeners.get("reInit")?.forEach(listener=>{listener();}); };
      const select = (index: number) => {
        selected = index;
        listeners.get("select")?.forEach((listener) => { listener(); });
      };
      const api = {
        selectedScrollSnap: () => selected,
        canScrollPrev: () => true,
        canScrollNext: () => true,
        scrollPrev: () => { select(selected === 0 ? 1 : 0); },
        scrollNext: () => { select(selected === 0 ? 1 : 0); },
        scrollTo: (index: number) => { select(index); },
        on: (event: string, listener: () => void) => {
          const handlers=listeners.get(event) ?? new Set<() => void>();
          handlers.add(listener);
          listeners.set(event,handlers);
          return api;
        },
        off: (event: string, listener: () => void) => {
          listeners.get(event)?.delete(listener);
          return api;
        },
      };
      return [() => undefined, api];
    }, []); },
  };
});

const productVariants = [
  {
    baseProductSlug: "staple-tee",
    color: "Black",
    mockupImageUrl: "/mockups/tee-black-cutout-v1.png",
  },
  {
    baseProductSlug: "staple-tee",
    color: "White",
    mockupImageUrl: "/mockups/tee-white-cutout-v1.png",
  },
  {
    baseProductSlug: "cotton-tote",
    color: "Black",
    mockupImageUrl: "/mockups/tote-black-print-bar-1001.webp",
  },
  {
    baseProductSlug: "cotton-tote",
    color: "Cream",
    mockupImageUrl: "/mockups/tote-cream-print-bar-1001.webp",
  },
] satisfies readonly {
  baseProductSlug: BaseProductSlug;
  color: string;
  mockupImageUrl: string;
}[];

describe("ProductMediaGallery", () => {
  let queryClient: QueryClient;
  function createGalleryRoot(container: HTMLElement) {
    const root = createRoot(container);
    return {
      render: (children: ReactNode) => {
        root.render(<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>);
      },
      unmount: () => { root.unmount(); },
    };
  }
  const fetchStoryVideo = vi.fn((_: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(
      init?.method === "HEAD"
        ? new Response(null, { headers: { etag: '"story-v5"' }, status: 200 })
        : new Response(new Blob(["video"], { type: "video/mp4" }), {
            headers: { "content-type": "video/mp4" },
            status: 200,
          }),
    )
  );

  beforeEach(() => {
    queryClient = new QueryClient();
    lifestyleState.ready=false;
    notifyManager.setScheduler(queueMicrotask);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", fetchStoryVideo);
  });

  afterEach(() => {
    queryClient.clear();
    notifyManager.setScheduler((callback) => setTimeout(callback, 0));
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(productVariants)("retains the paused $color $baseProductSlug video between slide visits", async ({ baseProductSlug, color }) => {
    const container = document.createElement("div");
    const root = createGalleryRoot(container);
    try {
      await act(async () => {
        root.render(<ProductMediaGallery baseProductSlug={baseProductSlug} color={color}
          productId="paused-frame" productTitle="bent.shop"><div>Flatlay</div></ProductMediaGallery>);
        await Promise.resolve();
      });
      act(() => { container.querySelector<HTMLButtonElement>('[aria-label="Show story video"]')?.click(); });
      const player = container.querySelector<HTMLVideoElement>('video[data-selected="true"]');
      if (!player) throw new Error("Expected the selected video.");
      const source = player.getAttribute("src");
      expect(source).toBeTruthy();
      player.dispatchEvent(new Event("loadedmetadata"));
      player.currentTime = 3;
      const load = vi.spyOn(player, "load");
      const pause = vi.spyOn(player, "pause");
      for (let visit = 0; visit < 3; visit++) {
        act(() => { container.querySelector<HTMLButtonElement>('[aria-label="Show product image"]')?.click(); });
        expect(pause).toHaveBeenCalled();
        expect(player.getAttribute("src")).toBe(source);
        expect(load).not.toHaveBeenCalled();
        act(() => { container.querySelector<HTMLButtonElement>('[aria-label="Show story video"]')?.click(); });
        expect(container.querySelector('video[data-selected="true"]')).toBe(player);
        expect(player.currentTime).toBe(3);
        expect(load).not.toHaveBeenCalled();
      }
      expect(fetchStoryVideo).toHaveBeenCalledTimes(2);
    } finally { act(() => { root.unmount(); }); }
  });

  it("does not load hidden videos during warmed flatlay colour switches", async () => {
    const container = document.createElement("div");
    const root = createGalleryRoot(container);
    const source = vi.spyOn(HTMLMediaElement.prototype, "src", "set");
    const render = (color: string) => { root.render(
      <ProductMediaGallery baseProductSlug="staple-tee" color={color}
        productId="warmed-product" productTitle="bent.shop">
        <div>{color} flatlay</div>
      </ProductMediaGallery>,
    ); };
    try {
      await act(async () => { render("Black"); await Promise.resolve(); });
      expect(container.querySelectorAll("video")).toHaveLength(2);
      expect(container.querySelectorAll("video[src]")).toHaveLength(0);
      for (const color of ["White", "Black", "White", "Black"]) {
        await act(async () => { render(color); await Promise.resolve(); });
      }
      expect(source).not.toHaveBeenCalled();
      act(() => { container.querySelector<HTMLButtonElement>('[aria-label="Show story video"]')?.click(); });
      expect(container.querySelectorAll("video[src]")).toHaveLength(1);
      source.mockClear();
      await act(async () => { render("White"); await Promise.resolve(); });
      expect(container.querySelector('[aria-label="Show product image"]')?.getAttribute("aria-pressed")).toBe("true");
      expect(container.querySelectorAll("video[src]")).toHaveLength(0);
      // Resetting from video must not briefly attach the new colour's source.
      expect(source).not.toHaveBeenCalled();
      expect(fetchStoryVideo).toHaveBeenCalledTimes(2);
    } finally {
      act(() => { root.unmount(); });
      source.mockRestore();
    }
  });

  it("changes retained lifestyle visibility without rerunning its media hooks", async () => {
    lifestyleState.ready = true;
    const container = document.createElement("div");
    const root = createGalleryRoot(container);
    const render = (color: string) => { root.render(
      <ProductMediaGallery baseProductSlug="staple-tee" color={color}
        productId="cached-lifestyle" productTitle="bent.shop"><div>Flatlay</div></ProductMediaGallery>,
    ); };
    try {
      await act(async () => { render("Black"); await Promise.resolve(); });
      const initialQueries = lifestyleQueries.mock.calls.length;
      for (const color of ["White", "Black", "White"]) {
        await act(async () => { render(color); await Promise.resolve(); });
      }
      expect(lifestyleQueries).toHaveBeenCalledTimes(initialQueries);
      expect(container.querySelector('[data-lifestyle-color="white"]')?.hasAttribute("hidden")).toBe(false);
      expect(container.querySelector('[data-lifestyle-color="black"]')?.hasAttribute("hidden")).toBe(true);
    } finally { act(() => { root.unmount(); }); }
  });

  it("places the lifestyle image second and keeps video playback on the third slide",async()=>{
    lifestyleState.ready=true;
    const container=document.createElement("div"),root=createGalleryRoot(container);
    try {
      await act(async()=>{root.render(<ProductMediaGallery baseProductSlug="staple-tee" color="White" productId="first" productTitle="bent.shop"><div>Flat</div></ProductMediaGallery>);await Promise.resolve();});
      const slides=Array.from(container.querySelectorAll('[data-slot="carousel-item"]'));
      expect(slides.map(slide=>slide.id)).toEqual(["product-media-product","product-media-lifestyle","product-media-video"]);
      act(()=>container.querySelector<HTMLButtonElement>('[aria-label="Show lifestyle image"]')?.click());
      expect(slides[1]?.getAttribute("aria-hidden")).toBe("false");
      expect(slides[2]?.getAttribute("aria-hidden")).toBe("true");
      act(()=>container.querySelector<HTMLButtonElement>('[aria-label="Show story video"]')?.click());
      expect(slides[2]?.getAttribute("aria-hidden")).toBe("false");
    } finally {act(()=>{ root.unmount(); });}
  });

  it("keeps the selected video playing when a late lifestyle slide arrives",async()=>{
    const container=document.createElement("div"),root=createGalleryRoot(container);
    try {
      await act(async()=>{
        root.render(<ProductMediaGallery baseProductSlug="staple-tee" color="White" productId="late-lifestyle" productTitle="bent.shop"><div>Flat</div></ProductMediaGallery>);
        await Promise.resolve();
      });
      act(()=>container.querySelector<HTMLButtonElement>('[aria-label="Show story video"]')?.click());
      const player=container.querySelector("video[src]");
      expect(player).not.toBeNull();
      act(()=>{
        lifestyleState.ready=true;
        lifestyleState.listeners.forEach(listener=>{listener();});
      });
      act(()=>{carouselState.reInit();});
      expect(container.querySelector('[aria-label="Show story video"]')?.getAttribute("aria-pressed")).toBe("true");
      expect(container.querySelector("video[src]")).toBe(player);
      expect(container.querySelector("#product-media-video")?.getAttribute("aria-hidden")).toBe("false");
    } finally {act(()=>{root.unmount();});}
  });

  it("returns to the image when colour or configured product changes", async () => {
    const container = document.createElement("div");
    const root = createGalleryRoot(container);
    const render = (color: string, productId: string) => { root.render(
      <ProductMediaGallery baseProductSlug="staple-tee" color={color}
        productId={productId} productTitle="bent.shop">
        <div>{color} product</div>
      </ProductMediaGallery>,
    ); };
    const imageSelected = () => container.querySelector('[aria-label="Show product image"]')
      ?.getAttribute("aria-pressed");
    const showVideo = () => container.querySelector<HTMLButtonElement>('[aria-label="Show story video"]')?.click();
    try {
      await act(async () => { render("Black", "first"); await Promise.resolve(); });
      act(showVideo);
      expect(imageSelected()).toBe("false");
      await act(async () => { render("White", "first"); await Promise.resolve(); });
      expect(imageSelected()).toBe("true");
      act(showVideo);
      await act(async () => { render("White", "second"); await Promise.resolve(); });
      expect(imageSelected()).toBe("true");
    } finally {
      act(() => { root.unmount(); });
    }
  });

  it("resets retained product panels and pauses their video on switching", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createGalleryRoot(container);
    const slugs: BaseProductSlug[] = ["staple-tee", "cotton-tote"];
    try {
      await act(async () => {
        root.render(<ProductFamily initialPanelId="staple-tee" syncUrl={false}
          entries={slugs.map((slug) => ({
            baseProductSlug: slug,
            panelId: slug,
            href: `/product/${slug}`,
            panel: <ProductMediaGallery baseProductSlug={slug} color="Black"
              productId={slug} productTitle={slug}><div>{slug}</div></ProductMediaGallery>,
          }))} />);
        await Promise.resolve();
      });
      expect(fetchStoryVideo).toHaveBeenCalledTimes(2);
      expect(fetchStoryVideo.mock.calls.every(([url]) => {
        const requestUrl = url instanceof Request
          ? url.url
          : url instanceof URL
            ? url.href
            : url;
        return requestUrl.includes("/staple-tee/");
      })).toBe(true);
      const shirt = container.querySelector("#configured-product-panel-staple-tee");
      const player = shirt?.querySelector("video");
      if (!player) throw new Error("Expected a ready shirt video.");
      const pause = vi.spyOn(player, "pause");
      const load = vi.spyOn(player, "load");
      // Retained panels and colour players must not retain media resources.
      expect(container.querySelectorAll("video[src]")).toHaveLength(0);
      act(() => { shirt?.querySelector<HTMLButtonElement>('[aria-label="Show story video"]')?.click(); });
      expect(shirt?.querySelector('[aria-label="Show story video"]')?.getAttribute("aria-pressed")).toBe("true");
      expect(container.querySelectorAll("video[src]")).toHaveLength(1);
      pause.mockClear();
      await act(async () => {
        container.querySelector<HTMLButtonElement>("#configured-product-tab-cotton-tote")?.click();
        await Promise.resolve();
      });
      expect(fetchStoryVideo).toHaveBeenCalledTimes(4);
      expect(pause).toHaveBeenCalled();
      expect(player.hasAttribute("src")).toBe(false);
      expect(load).toHaveBeenCalled();
      expect(container.querySelectorAll("video[src]")).toHaveLength(0);
      act(() => { container.querySelector<HTMLButtonElement>("#configured-product-tab-staple-tee")?.click(); });
      expect(shirt?.querySelector('[aria-label="Show product image"]')?.getAttribute("aria-pressed")).toBe("true");
      expect(shirt?.querySelector("video")).toBe(player);
      expect(container.querySelectorAll("video[src]")).toHaveLength(0);
    } finally {
      act(() => { root.unmount(); });
      container.remove();
    }
  });

  it.each(productVariants)(
    "adds the $color $baseProductSlug video as a second slide",
    async ({ baseProductSlug, color }) => {
      const container = document.createElement("div");
      const root = createGalleryRoot(container);
      const productId = "product-1";

      await act(async () => {
        root.render(
          <ProductMediaGallery
            baseProductSlug={baseProductSlug}
            color={color}
            productId={productId}
            productTitle="Bent product"
          >
            <div role="img" aria-label={`${color} product`} />
          </ProductMediaGallery>,
        );
        await Promise.resolve();
      });

      const readinessUrl =
        `/api/configured-product-video/${productId}/${color.toLowerCase()}.mp4`;
      const expectedVideoUrl = `${readinessUrl}?v=%22story-v5%22&access=revocable-v1`;
      expect(fetchStoryVideo).toHaveBeenCalledWith(
        readinessUrl,
        expect.objectContaining({ cache: "no-store", method: "HEAD" }),
      );
      expect(
        container.querySelector('[data-slot="carousel"]')?.className,
      ).toContain("bg-primary");
      expect(
        container.querySelector("[data-product-gallery-image]")?.className,
      ).toContain("bg-white");
      expect(
        container.querySelector('button[aria-label="Show product image"] img'),
      ).toBeNull();
      expect(
        container.querySelector('button[aria-label="Show story video"] video'),
      ).toBeNull();
      const mediaPicker = container.querySelector(
        '[aria-label="Choose product media"]',
      );
      expect(mediaPicker?.textContent).toBe("");
      expect(mediaPicker?.className).not.toContain("bg-background");
      expect(mediaPicker?.querySelectorAll("button")).toHaveLength(2);
      expect(mediaPicker?.querySelector("button:first-child")?.className)
        .toContain("justify-items-end pr-1");
      expect(mediaPicker?.querySelector("button:last-child")?.className)
        .toContain("justify-items-start pl-1");
      for (const indicator of mediaPicker?.querySelectorAll("button") ?? []) {
        expect(indicator.className).toContain("size-11");
        expect(indicator.className).toContain("items-end");
        expect(indicator.className).toContain("pb-2");
      }
      expect(mediaPicker?.querySelector("span")?.className).toContain("border-primary");
      expect(mediaPicker?.querySelector("span")?.className).toContain("group-aria-pressed:border-white");
      expect(mediaPicker?.querySelector("span")?.className).toContain("group-aria-pressed:shadow-[0_0_0_1px_var(--blue)]");
      const previous = container.querySelector<HTMLButtonElement>('[data-slot="carousel-previous"]');
      const next = container.querySelector<HTMLButtonElement>('[data-slot="carousel-next"]');
      expect(previous?.className).toContain("max-[900px]:hidden");
      expect(next?.className).toContain("max-[900px]:hidden");
      act(() => { next?.click(); });
      expect(container.querySelector('[aria-label="Show story video"]')?.getAttribute("aria-pressed")).toBe("true");
      act(() => { previous?.click(); });
      expect(container.querySelector('[aria-label="Show product image"]')?.getAttribute("aria-pressed")).toBe("true");
      const indicators = container.querySelector(
        '[data-slot="carousel-indicators"]',
      );
      expect(indicators?.children).toHaveLength(2);
      expect(
        indicators?.querySelectorAll('[data-active="true"]'),
      ).toHaveLength(1);
      const storyVideo = container.querySelector<HTMLVideoElement>(
        '#product-media-video video[data-selected="true"]',
      );
      expect(storyVideo?.hasAttribute("src")).toBe(true);
      act(() => { next?.click(); });
      expect(storyVideo?.getAttribute("src"))
        .toBe(expectedVideoUrl);
      expect(storyVideo?.hasAttribute("poster")).toBe(false);
      expect(storyVideo?.className).toContain("aspect-[9/16]");
      expect(storyVideo?.hasAttribute("controls")).toBe(false);
      expect(storyVideo?.hasAttribute("loop")).toBe(false);
      expect(container.querySelector('button[aria-label="Share video"] .lucide-share'))
        .not.toBeNull();

      act(() => {
        root.unmount();
      });
    },
  );

  it("waits for a pending render before exposing versioned playback", async () => {
    vi.useFakeTimers();
    fetchStoryVideo.mockResolvedValueOnce(new Response(null, {
      headers: { "retry-after": "2" },
      status: 202,
    }));
    fetchStoryVideo.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const container = document.createElement("div");
    const root = createGalleryRoot(container);

    await act(async () => {
      root.render(
        <ProductMediaGallery
          baseProductSlug="staple-tee"
          color="Black"
          productId="pending-product"
          productTitle="bent.shop"
        >
          <div role="img" aria-label="Black product" />
        </ProductMediaGallery>,
      );
      await Promise.resolve();
    });
    expect(container.querySelector("video")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(fetchStoryVideo).toHaveBeenCalledTimes(3);
    expect(container.querySelector("video")?.hasAttribute("src")).toBe(false);
    act(() => { container.querySelector<HTMLButtonElement>('[aria-label="Show story video"]')?.click(); });
    expect(container.querySelector("video")?.getAttribute("src"))
      .toBe("/api/configured-product-video/pending-product/black.mp4?v=%22story-v5%22&access=revocable-v1");

    act(() => {
      root.unmount();
    });
  });

  it("keeps a ready video available when returning to a previously viewed colour", async () => {
    const container = document.createElement("div");
    const root = createGalleryRoot(container);
    const renderColour = (color: string) => (
      <ProductMediaGallery
        baseProductSlug="staple-tee"
        color={color}
        productId="returning-product"
        productTitle="bent.shop"
      >
        <div role="img" aria-label={`${color} product`} />
      </ProductMediaGallery>
    );

    try {
      await act(async () => { root.render(renderColour("Black")); await Promise.resolve(); });
      const showVideo = () => container.querySelector<HTMLButtonElement>('[aria-label="Show story video"]')?.click();
      act(showVideo);
      const blackPlayer = container.querySelector<HTMLVideoElement>('video[data-selected="true"]');
      if (!blackPlayer) throw new Error("Expected the black video player.");
      const load = vi.spyOn(blackPlayer, "load").mockImplementation(() => {
        blackPlayer.currentTime = 0;
      });
      act(() => { blackPlayer.dispatchEvent(new Event("loadedmetadata")); });
      blackPlayer.currentTime = 1.25;
      await act(async () => { root.render(renderColour("White")); await Promise.resolve(); });
      expect(container.querySelectorAll("video[src]")).toHaveLength(0);
      act(showVideo);
      expect(container.querySelector('video[data-selected="true"]')?.getAttribute("src"))
        .toContain("white.mp4");
      expect(blackPlayer.className).toContain("hidden");
      expect(blackPlayer.hasAttribute("src")).toBe(false);
      expect(load).toHaveBeenCalled();
      expect(container.querySelectorAll("video[src]")).toHaveLength(1);

      // A repeat visit must not wait for another readiness round trip.
      await act(async () => {
        root.render(renderColour("Black"));
        await Promise.resolve();
      });
      act(showVideo);

      // Switching away before metadata arrives must not erase the saved time.
      await act(async () => { root.render(renderColour("White")); await Promise.resolve(); });
      await act(async () => { root.render(renderColour("Black")); await Promise.resolve(); });
      act(showVideo);

      expect(container.querySelector('video[data-selected="true"]')).toBe(blackPlayer);
      act(() => { blackPlayer.dispatchEvent(new Event("loadedmetadata")); });
      expect(blackPlayer.currentTime).toBe(1.25);
      expect(blackPlayer.getAttribute("src"))
        .toBe("/api/configured-product-video/returning-product/black.mp4?v=%22story-v5%22&access=revocable-v1");
      expect(fetchStoryVideo).toHaveBeenCalledTimes(2);
      act(() => { root.unmount(); });
      expect(blackPlayer.hasAttribute("src")).toBe(false);
      expect(load).toHaveBeenCalledTimes(3);
    } finally {
      act(() => { root.unmount(); });
    }
  });

  it.each(productVariants)(
    "offers replay only after the $color $baseProductSlug video ends",
    async ({ baseProductSlug, color }) => {
      const container = document.createElement("div");
      const root = createGalleryRoot(container);
      const replayButton = () => container.querySelector<HTMLButtonElement>(
        'button[aria-label="Replay video"]',
      );

      try {
        await act(async () => {
          root.render(
            <ProductMediaGallery baseProductSlug={baseProductSlug} color={color}
              productId="replay-product" productTitle="Bent product">
              <div role="img" aria-label={`${color} product`} />
            </ProductMediaGallery>,
          );
          await Promise.resolve();
        });
        const player = container.querySelector<HTMLVideoElement>('video[data-selected="true"]');
        if (!player) throw new Error("Expected a selected video player.");
        act(() => { container.querySelector<HTMLButtonElement>('[aria-label="Show story video"]')?.click(); });
        expect(replayButton()).toBeNull();
        act(() => { player.dispatchEvent(new Event("pause")); });
        expect(replayButton()).toBeNull();

        player.currentTime = 8;
        act(() => { player.dispatchEvent(new Event("ended")); });
        expect(replayButton()?.className).toContain("top-16");
        expect(replayButton()?.querySelector(".lucide-rotate-ccw")).not.toBeNull();
        expect(container.querySelector('button[aria-label="Share video"]')).not.toBeNull();

        const play = vi.spyOn(player, "play").mockRejectedValueOnce(new Error("Playback interrupted"));
        await act(async () => { replayButton()?.click(); await Promise.resolve(); });
        expect(replayButton()).not.toBeNull();
        play.mockImplementation(() => {
          player.dispatchEvent(new Event("play"));
          return Promise.resolve();
        });
        await act(async () => { replayButton()?.click(); await Promise.resolve(); });
        expect(play).toHaveBeenCalled();
        expect(player.currentTime).toBe(0);
        expect(replayButton()).toBeNull();
        expect(player.loop).toBe(false);
        expect(fetchStoryVideo).toHaveBeenCalledTimes(2);

        act(() => { player.dispatchEvent(new Event("ended")); });
        expect(replayButton()).not.toBeNull();
        play.mockRestore();
      } finally {
        act(() => { root.unmount(); });
      }
    },
  );

  it("keeps replay state with the completed colour's cached player", async () => {
    const container = document.createElement("div");
    const root = createGalleryRoot(container);
    const gallery = (color: string) => (
      <ProductMediaGallery baseProductSlug="staple-tee" color={color}
        productId="replay-colours" productTitle="bent.shop">
        <div role="img" aria-label={`${color} product`} />
      </ProductMediaGallery>
    );
    try {
      await act(async () => { root.render(gallery("Black")); await Promise.resolve(); });
      act(() => { container.querySelector<HTMLButtonElement>('[aria-label="Show story video"]')?.click(); });
      const blackPlayer = container.querySelector('video[data-selected="true"]');
      if (!blackPlayer) throw new Error("Expected the black video player.");
      act(() => { blackPlayer.dispatchEvent(new Event("ended")); });
      expect(container.querySelector('button[aria-label="Replay video"]')).not.toBeNull();
      await act(async () => { root.render(gallery("White")); await Promise.resolve(); });
      expect(container.querySelector('button[aria-label="Replay video"]')).toBeNull();
      await act(async () => { root.render(gallery("Black")); await Promise.resolve(); });
      act(() => { container.querySelector<HTMLButtonElement>('[aria-label="Show story video"]')?.click(); });
      expect(container.querySelector('video[data-selected="true"]')).toBe(blackPlayer);
      expect(container.querySelectorAll('button[aria-label="Replay video"]')).toHaveLength(1);
      expect(fetchStoryVideo).toHaveBeenCalledTimes(2);
    } finally {
      act(() => { root.unmount(); });
    }
  });

  it("shares the video file without adding product copy or a URL", async () => {
    const share = vi.fn(() => Promise.resolve());
    const canShare = vi.fn<(data: ShareData) => boolean>(() => true);
    vi.stubGlobal("navigator", { canShare, share });
    const container = document.createElement("div");
    const root = createGalleryRoot(container);

    await act(async () => {
      root.render(
        <ProductMediaGallery
          baseProductSlug="staple-tee"
          color="white"
          productId="product-1"
          productTitle="Box Tee"
        >
          <div role="img" aria-label="White Box Tee" />
        </ProductMediaGallery>,
      );
      await Promise.resolve();
    });

    const shareVideo = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Share video"]',
    );
    act(() => { container.querySelector<HTMLButtonElement>('[aria-label="Show story video"]')?.click(); });
    await act(async () => {
      shareVideo?.click();
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("Download video");

    const sharedFile = canShare.mock.calls[0]?.[0].files?.[0];
    expect(sharedFile?.name).toBe("box-tee-story.mp4");
    expect(sharedFile?.type).toBe("video/mp4");
    expect(share).toHaveBeenCalledWith({ files: [sharedFile] });
    expect(fetchStoryVideo).toHaveBeenLastCalledWith(
      "/api/configured-product-video/product-1/white.mp4?v=%22story-v5%22&access=revocable-v1",
    );

    act(() => {
      root.unmount();
    });
  });

  it("reuses readiness after the gallery unmounts during navigation", async () => {
    const container = document.createElement("div");
    let root = createGalleryRoot(container);
    const gallery = (
      <ProductMediaGallery baseProductSlug="staple-tee" color="Black"
        productId="navigation-product" productTitle="bent.shop">
        <div role="img" aria-label="Black product" />
      </ProductMediaGallery>
    );
    await act(async () => { root.render(gallery); await Promise.resolve(); });
    expect(fetchStoryVideo).toHaveBeenCalledTimes(2);
    act(() => { root.unmount(); });
    root = createGalleryRoot(container);
    try {
      await act(async () => { root.render(gallery); await Promise.resolve(); });
      act(() => { container.querySelector<HTMLButtonElement>('[aria-label="Show story video"]')?.click(); });
      expect(container.querySelector('video[data-selected="true"]')?.getAttribute("src"))
        .toContain("navigation-product/black.mp4");
      expect(fetchStoryVideo).toHaveBeenCalledTimes(2);
    } finally {
      act(() => { root.unmount(); });
    }
  });

  it("does not show another product's cached video while readiness is pending", async () => {
    const container = document.createElement("div");
    const root = createGalleryRoot(container);
    const gallery = (productId: string) => (
      <ProductMediaGallery baseProductSlug="staple-tee" color="Black"
        productId={productId} productTitle="bent.shop">
        <div role="img" aria-label="Black product" />
      </ProductMediaGallery>
    );
    try {
      await act(async () => { root.render(gallery("first-product")); await Promise.resolve(); });
      fetchStoryVideo.mockResolvedValueOnce(new Response(null, { status: 202 }));
      fetchStoryVideo.mockResolvedValueOnce(new Response(null, { status: 202 }));
      await act(async () => { root.render(gallery("second-product")); await Promise.resolve(); });
      expect(container.querySelector("video")).toBeNull();
      expect(container.querySelector('[data-slot="carousel-indicators"]')).toBeNull();
    } finally {
      act(() => { root.unmount(); });
    }
  });

  it("keeps the cached player visible during revalidation then adopts the new ETag", async () => {
    const container = document.createElement("div");
    const root = createGalleryRoot(container);
    try {
      await act(async () => {
        root.render(
        <ProductMediaGallery baseProductSlug="staple-tee" color="Black"
          productId="revalidated-product" productTitle="bent.shop">
          <div role="img" aria-label="Black product" />
        </ProductMediaGallery>,
        );
        await Promise.resolve();
      });
      const player = container.querySelector('video[data-selected="true"]');
      act(() => { container.querySelector<HTMLButtonElement>('[aria-label="Show story video"]')?.click(); });
      let completeReadiness: ((response: Response) => void) | undefined;
      fetchStoryVideo.mockImplementationOnce(() => new Promise<Response>((resolve) => {
        completeReadiness = resolve;
      }));
      await act(async () => {
        void queryClient.invalidateQueries({
          queryKey: ["story-video", "revalidated-product", "black"],
        });
        await Promise.resolve();
      });
      expect(container.querySelector('video[data-selected="true"]')).toBe(player);
      await act(async () => {
        completeReadiness?.(new Response(null, {
          status: 200, headers: { etag: '"story-v6"' },
        }));
        await Promise.resolve();
      });
      expect(container.querySelector('video[data-selected="true"]')?.getAttribute("src"))
        .toContain("?v=%22story-v6%22");
      expect(container.querySelector('video[data-selected="true"]')).not.toBe(player);
    } finally {
      act(() => { root.unmount(); });
    }
  });
});
