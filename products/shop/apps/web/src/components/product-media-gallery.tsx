"use client";

import { productProjectionSpecification, type BaseProductSlug } from "@forever-tee/contracts/product-projection";
import { RotateCcwIcon, ShareIcon } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { useProductPanelActive, useProductMediaWarmup } from "@/components/product-family";
import {
  Carousel,
  type CarouselApi,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
import { shareProductFile } from "@/lib/product-sharing";
import { useBrowserLifestyle } from "@/lib/use-browser-lifestyle";
import { useLifestyleImage } from "@/lib/use-lifestyle-image";
import { useStoryVideos } from "@/lib/use-story-videos";
import { cn } from "@/lib/utils";

interface ProductMediaGalleryProps {
  baseProductSlug: BaseProductSlug;
  children: ReactNode;
  color: string;
  productId: string | undefined;
  revision?: string | undefined;
  productTitle: string;
}

type ProductMedia = "product" | "lifestyle" | "video";

function storyVideoFileName(title: string) {
  const name = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${name || "bent-shirt"}-story.mp4`;
}

function downloadFile(file: File) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

export function ProductMediaGallery(props: ProductMediaGalleryProps) {
  return <ProductMediaGalleryContent key={`${props.productId ?? ""}/${props.revision ?? ""}`} {...props} />;
}

function ProductMediaGalleryContent({
  baseProductSlug,
  children,
  color,
  productId,
  productTitle,
  revision,
}: ProductMediaGalleryProps) {
  const [selection, setSelection] = useState<{ color: string; media: ProductMedia }>({ color, media: "product" });
  const [carouselApi, setCarouselApi] = useState<CarouselApi>();
  const [shareFailed, setShareFailed] = useState(false);
  const [availableLifestyleColors, setAvailableLifestyleColors] = useState<Record<string, boolean>>({});
  const lifestyleAvailable = useCallback((variantColor: string, available: boolean) => {
    setAvailableLifestyleColors(previous => previous[variantColor] === available ? previous : { ...previous, [variantColor]: available });
  }, []);
  const panelActive = useProductPanelActive();
  const { warm } = useProductMediaWarmup();
  const colors = productProjectionSpecification(baseProductSlug).colors;
  const videoQueries = useStoryVideos(productId, colors, panelActive);
  const videos = videoQueries.flatMap((query, index) => {
    const variantColor = colors[index];
    return query.data?.status === "ready" && variantColor
      ? [{ color: variantColor, url: query.data.url }]
      : [];
  });
  const video = videos.find((item) => item.color.toLowerCase() === color.toLowerCase())?.url;
  const lifestyle = baseProductSlug === "staple-tee" && Object.values(availableLifestyleColors).some(Boolean);
  const videoSlide = lifestyle ? 2 : 1;
  // A colour change returns to the flatlay before carousel effects run, so a
  // hidden video decoder is never loaded for the new colour.
  // Preserve the selected media when a late preview changes slide positions.
  const activeSlide = selection.color !== color ? 0
    : selection.media === "video" && video ? videoSlide
      : selection.media === "lifestyle" && lifestyle ? 1 : 0;
  const mediaLabels = ["Show product image", ...(lifestyle ? ["Show lifestyle image"] : []), ...(video ? ["Show story video"] : [])];
  const visibleSlide = (video || lifestyle) && panelActive ? activeSlide : 0;

  useEffect(() => {
    carouselApi?.scrollTo(0, true);
  }, [carouselApi, baseProductSlug, color, productId, panelActive]);

  useEffect(() => {
    if (!carouselApi) return;
    const updateActiveSlide = () => {
      const slide = carouselApi.selectedScrollSnap();
      const media = slide === videoSlide && video ? "video"
        : slide === 1 && lifestyle ? "lifestyle" : "product";
      setSelection(previous => previous.media === media && previous.color === color
        ? previous : { color, media });
    };
    const restoreSelectedMedia = () => { carouselApi.scrollTo(activeSlide, true); };
    carouselApi.on("select", updateActiveSlide);
    carouselApi.on("reInit", restoreSelectedMedia);
    return () => {
      carouselApi.off("select", updateActiveSlide);
      carouselApi.off("reInit", restoreSelectedMedia);
    };
  }, [carouselApi, color, activeSlide, lifestyle, video, videoSlide]);

  useEffect(() => {
    if (!video && !lifestyle) {
      carouselApi?.scrollTo(0, true);
    }
  }, [carouselApi, video, lifestyle]);

  async function shareVideo() {
    if (!video) return;
    setShareFailed(false);
    try {
      const response = await fetch(video);
      if (!response.ok) throw new Error("The story video is unavailable.");
      const file = new File(
        [await response.blob()],
        storyVideoFileName(productTitle),
        { type: "video/mp4" },
      );
      const result = await shareProductFile(navigator, file);
      if (result === "fallback") {
        setShareFailed(true);
        downloadFile(file);
      }
    } catch {
      setShareFailed(true);
    }
  }

  return (
    <Carousel
      aria-label="Product gallery"
      className="aspect-square w-full overflow-hidden border border-primary bg-primary max-[900px]:border-y-0"
      opts={{ loop: true }}
      setApi={setCarouselApi}
    >
      <CarouselContent className="-ml-0 h-full">
        <CarouselItem
          aria-hidden={visibleSlide !== 0}
          className="h-full pl-0"
          id="product-media-product"
          inert={visibleSlide !== 0}
        >
          <div className="size-full bg-white" data-product-gallery-image>
            {children}
          </div>
        </CarouselItem>
        {baseProductSlug === "staple-tee" ? (
          <CarouselItem aria-hidden={visibleSlide !== 1} inert={visibleSlide !== 1}
            hidden={!lifestyle} className="relative h-full bg-white pl-0" id="product-media-lifestyle">
            {colors.map(variantColor => <div key={variantColor} className="size-full"
              hidden={variantColor.toLowerCase() !== color.toLowerCase()} data-lifestyle-color={variantColor.toLowerCase()}>
              <RetainedLifestyleImage color={variantColor} productId={productId}
                revision={revision} productTitle={productTitle} enabled={warm || panelActive}
                onAvailability={lifestyleAvailable} />
            </div>)}
          </CarouselItem>
        ) : null}
        {video ? (
          <CarouselItem
            aria-hidden={visibleSlide !== videoSlide}
            className="h-full bg-primary pl-0"
            id="product-media-video"
            inert={visibleSlide !== videoSlide}
          >
            <div className="relative grid size-full place-items-center bg-primary">
              {videos.map((item) => (
                <StoryVideoPlayer
                  active={visibleSlide === videoSlide && item.url === video}
                  key={item.url}
                  loadable={panelActive && item.url === video}
                  selected={item.url === video}
                  title={`${item.color} ${productTitle} story video`}
                  url={item.url}
                />
              ))}
              <Button
                aria-label="Share video"
                className="absolute top-3 right-3 z-20 size-11 rounded-none border-primary bg-background text-primary hover:bg-primary hover:text-primary-foreground"
                size="icon-lg"
                type="button"
                variant="outline"
                onClick={() => {
                  void shareVideo();
                }}
              >
                <ShareIcon className="size-5" />
              </Button>
              {shareFailed ? (
                <p className="sr-only" role="status">
                  The share sheet was unavailable, so the video was downloaded.
                </p>
              ) : null}
            </div>
          </CarouselItem>
        ) : null}
      </CarouselContent>

      {mediaLabels.length > 1 ? (
        <>
          <CarouselPrevious
            className="left-3 z-20 size-11 rounded-none border-primary bg-background text-primary hover:bg-primary hover:text-primary-foreground max-[900px]:hidden"
          />
          <CarouselNext
            className="right-3 z-20 size-11 rounded-none border-primary bg-background text-primary hover:bg-primary hover:text-primary-foreground max-[900px]:hidden"
          />
        </>
      ) : null}

      {mediaLabels.length > 1 ? (
          <div
            aria-label="Choose product media"
            className="absolute bottom-0 left-1/2 z-20 flex -translate-x-1/2"
            data-slot="carousel-indicators"
            role="group"
          >
            {mediaLabels.map((label, slide) => (
              <button
                aria-label={label}
                aria-pressed={visibleSlide === slide}
                className={cn(
                  "group grid size-11 items-end pb-2 outline-none focus-visible:outline-1 focus-visible:outline-primary",
                  mediaLabels.length > 2 ? "w-6 justify-items-center" : slide === 0 ? "justify-items-end pr-1" : "justify-items-start pl-1",
                )}
                data-active={visibleSlide === slide}
                key={label}
                type="button"
                onClick={() => carouselApi?.scrollTo(slide)}
              >
                <span className="size-2.5 rounded-full border border-primary bg-white group-aria-pressed:border-white group-aria-pressed:bg-primary group-aria-pressed:shadow-[0_0_0_1px_var(--blue)]" />
              </button>
            ))}
          </div>
      ) : null}
      {video ? (
        <span className="sr-only" role="status">
          Story video ready.
        </span>
      ) : null}
    </Carousel>
  );
}

const RetainedLifestyleImage = memo(function RetainedLifestyleImage({ color, productId, revision, productTitle, enabled, onAvailability }: {
  color: string; productId: string | undefined; revision: string | undefined;
  productTitle: string; enabled: boolean; onAvailability: (color: string, available: boolean) => void;
}) {
  const [serverLoaded, setServerLoaded] = useState(false);
  const query = useLifestyleImage(productId, color, enabled);
  const source = query.data?.status === "ready" ? query.data.url : undefined;
  const backup = useBrowserLifestyle(productId, revision, color, enabled && !serverLoaded && query.data?.status !== "unavailable");
  useEffect(() => { onAvailability(color, Boolean(source ?? backup)); }, [color, source, backup, onAvailability]);
  return <>
    {!serverLoaded && backup ? (
      /* eslint-disable-next-line @next/next/no-img-element -- Ephemeral browser display image. */
      <img src={backup} width={1086} height={1448} alt={`${color} ${productTitle} worn on a model`}
        className="absolute inset-0 size-full object-contain" />
    ) : null}
    {source ? (
      /* eslint-disable-next-line @next/next/no-img-element -- Revocable R2 image served through the application. */
      <img src={source} width={1086} height={1448} alt={`${color} ${productTitle} worn on a model`}
        className="absolute inset-0 size-full object-contain" loading={enabled ? "eager" : "lazy"}
        onLoad={() => { setServerLoaded(true); }} style={{ visibility: serverLoaded ? "visible" : "hidden" }} />
    ) : null}
    {!source && !backup ? <p className="grid size-full place-content-center font-mono text-xs text-primary" role="status">
      {query.data?.status === "unavailable" ? "Preview could not be loaded." : "Preparing preview…"}
    </p> : null}
  </>;
});

function StoryVideoPlayer({ active, loadable, selected, title, url }: {
  active: boolean;
  loadable: boolean;
  selected: boolean;
  title: string;
  url: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playbackTime = useRef(0);
  const [hasEnded, setHasEnded] = useState(false);

  useEffect(() => {
    const element = videoRef.current;
    if (!element || !loadable) return;

    let metadataLoaded = false;
    const restorePlaybackTime = () => {
      metadataLoaded = true;
      if (playbackTime.current > 0) element.currentTime = playbackTime.current;
    };
    element.addEventListener("loadedmetadata", restorePlaybackTime);
    return () => {
      if (metadataLoaded) playbackTime.current = element.currentTime;
      element.removeEventListener("loadedmetadata", restorePlaybackTime);
      element.pause();
      // Release the decoder on colour/product changes or unmount, while a
      // slide change only pauses the viewed video and preserves its picture.
      if (element.hasAttribute("src")) {
        element.removeAttribute("src");
        element.load();
      }
    };
  }, [loadable, url]);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    // Untouched videos stay unloaded. Once viewed, retain the selected source
    // between slide visits until its colour or product becomes inactive.
    if (active && loadable && !element.hasAttribute("src")) element.src = url;
    if (active && !hasEnded) void element.play().catch(() => undefined);
    else element.pause();
    return () => { element.pause(); };
  }, [active, hasEnded, loadable, url]);

  return (
    <>
      <video
        ref={videoRef}
        aria-hidden={!selected}
        aria-label={title}
        className={cn(
          "aspect-[9/16] h-full w-[56.25%] bg-primary object-contain",
          !selected && "hidden",
        )}
        data-selected={selected}
        muted
        onEnded={() => { setHasEnded(true); }}
        onPlay={() => { setHasEnded(false); }}
        playsInline
        preload={loadable ? "auto" : "none"}
      >
        Your browser does not support video playback.
      </video>
      {selected && hasEnded ? (
        <Button
          aria-label="Replay video"
          className="absolute top-16 right-3 z-20 size-11 rounded-none border-primary bg-background text-primary hover:bg-primary hover:text-primary-foreground"
          size="icon-lg"
          type="button"
          variant="outline"
          onClick={() => {
            const element = videoRef.current;
            if (!element) return;
            element.currentTime = 0;
            void element.play().catch(() => undefined);
          }}
        >
          <RotateCcwIcon className="size-5" />
        </Button>
      ) : null}
    </>
  );
}
