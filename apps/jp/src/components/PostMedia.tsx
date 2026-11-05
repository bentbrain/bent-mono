import { useEffect, useState } from 'react';
import { mediaUrl, posterUrl, type TripMedia } from '../lib/model';
import { responsiveImage, cardImageSizes } from '../lib/responsive-image';
import { shopDesignSchema } from '../lib/shop-design';
import { PostDesign } from './PostDesign';
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  useCarousel,
  type CarouselOptions,
} from './ui/carousel';

function CarouselControls({ count }: { count: number }) {
  const { api } = useCarousel();
  const [current, setCurrent] = useState(1);
  useEffect(() => {
    if (!api) return;
    const update = () => {
      const selected = api.selectedScrollSnap();
      setCurrent(selected + 1);
      api.slideNodes().forEach((slide, index) => {
        slide.dataset.videoActive = String(index === selected);
      });
    };
    update();
    api.on('select', update);
    api.on('reInit', update);
    return () => {
      api.off('select', update);
      api.off('reInit', update);
    };
  }, [api]);
  return count > 1 ? (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <span aria-live="polite" aria-atomic="true">
        {current} / {count}
      </span>
      <div className="flex gap-2">
        <CarouselPrevious />
        <CarouselNext />
      </div>
    </div>
  ) : null;
}

const carouselOptions: CarouselOptions = {
  align: 'start',
  containScroll: 'trimSnaps',
  breakpoints: {
    '(prefers-reduced-motion: reduce)': { duration: 0 },
  },
  watchDrag: (_api, event) => {
    const video =
      event.target instanceof Element ? event.target.closest('video') : null;
    if (!(video instanceof HTMLVideoElement)) return true;
    if (document.fullscreenElement) return false;
    const point = 'touches' in event ? event.touches[0] : event;
    // Leave the native control bar's pointer gestures to the video player.
    return Boolean(
      point && point.clientY < video.getBoundingClientRect().bottom - 56,
    );
  },
};

export function PostMedia({
  items,
  design: value,
  title,
  sizes = cardImageSizes,
  responsive = true,
}: {
  items: TripMedia[];
  design?: unknown;
  title: string;
  sizes?: string;
  responsive?: boolean;
}) {
  const parsed = shopDesignSchema.safeParse(value);
  const design = parsed.success ? parsed.data : undefined;
  const count = items.length + (design ? 1 : 0);
  if (!count) return null;
  return (
    <Carousel
      className="post-carousel min-w-0"
      aria-label={`${title} media`}
      opts={carouselOptions}
    >
      <CarouselContent className="post-media ml-0 h-[min(320px,50svh)] touch-pan-y items-start select-none">
        {items.map((item, index) => (
          <CarouselItem
            key={item.id}
            aria-label={`${String(index + 1)} of ${String(count)}`}
            data-video-active={index === 0 ? 'true' : 'false'}
            className="h-full basis-full pl-0"
          >
            {item.kind === 'video' ? (
              <div
                className="media-tile relative h-full min-w-0 overflow-hidden bg-muted"
                data-feedback-id={`media-${item.id}`}
              >
                <video
                  data-visibility-video
                  muted
                  loop
                  src={mediaUrl(item)}
                  poster={posterUrl(item)}
                  controls
                  playsInline
                  preload="none"
                  aria-label={item.title}
                  className="block size-full object-contain"
                />
              </div>
            ) : (
              <a
                className="media-tile relative block h-full min-w-0 overflow-hidden bg-muted"
                href={`/media/${item.slug || item.id}`}
                aria-label={item.title}
                data-feedback-id={`media-${item.id}`}
                draggable={false}
              >
                <img
                  {...(responsive
                    ? responsiveImage(posterUrl(item), sizes)
                    : { src: posterUrl(item) })}
                  alt={item.title}
                  loading="lazy"
                  draggable={false}
                  className="block size-full object-contain"
                />
              </a>
            )}
          </CarouselItem>
        ))}
        {design && (
          <CarouselItem
            aria-label={`${String(count)} of ${String(count)}, shop design`}
            className="post-design-slide h-full basis-full px-4 pb-4 [&_.post-design]:h-full [&_.post-design_img]:h-full"
          >
            <PostDesign design={design} />
          </CarouselItem>
        )}
      </CarouselContent>
      <CarouselControls count={count} />
    </Carousel>
  );
}
