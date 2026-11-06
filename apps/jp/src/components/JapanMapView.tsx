import { useEffect, useMemo, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import type { MapReference } from '../lib/map';
import type { MapProjection } from '../lib/map-context';
import { MapContext } from './MapContext';
import { MapPlaceLabels } from './MapPlaceLabels';
import { resolveMapPhoto } from '../lib/map-photo-controller';
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from './ui/popover';
import { Button, buttonVariants } from './ui/button';
import {
  clusterMapPoints,
  fitMapPoints,
  MAX_MAP_ZOOM,
  MIN_MAP_ZOOM,
  zoomMapAt,
  type MapCamera,
  type MapPoint,
} from '../lib/map-view';

type MapItem = MapPoint & {
  id: string;
  slug: string | null;
  title: string;
  place: string;
  kind: 'photo' | 'video';
  src: string;
  poster: string;
  photoResolution?: string;
  photo?: {
    src: string;
    srcSet?: string;
    sizes?: string;
    width?: number;
    height?: number;
  };
};
const controlClass =
  'size-11 bg-background p-0 text-foreground hover:bg-foreground hover:text-background dark:bg-background dark:hover:bg-foreground';

function MapPhoto({ item, onLoad }: { item: MapItem; onLoad: () => void }) {
  const [photo, setPhoto] = useState<MapItem['photo']>(
    item.photoResolution ? undefined : item.photo || { src: item.poster },
  );
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!item.photoResolution) return;
    return resolveMapPhoto({
      url: item.photoResolution,
      poster: item.poster,
      ready: setPhoto,
      failed: () => {
        setFailed(true);
      },
    });
  }, [item, attempt]);
  if (photo)
    return (
      <img
        {...photo}
        style={
          photo.width && photo.height
            ? {
                width: `min(100%, ${String(photo.width)}px, ${String((55 * photo.width) / photo.height)}dvh)`,
                aspectRatio: `${String(photo.width)} / ${String(photo.height)}`,
              }
            : undefined
        }
        alt={item.title}
        loading="eager"
        onLoad={(event) => {
          void event.currentTarget.decode().then(onLoad, onLoad);
        }}
        className="block h-auto max-h-[55dvh] w-auto max-w-full shrink-0 self-center object-contain"
      />
    );
  return failed ? (
    <Button
      variant="link"
      onClick={() => {
        setFailed(false);
        setAttempt((current) => current + 1);
      }}
    >
      RETRY PHOTO
    </Button>
  ) : (
    <span role="status" className="self-center">
      loading photo
    </span>
  );
}

// Keep only this location's current photo and immediate neighbors alive. Hidden
// eager images use the same responsive candidates and decoded DOM nodes as the
// visible photo, without preloading video bodies or the rest of the library.
function MapPhotos({ items, index }: { items: MapItem[]; index: number }) {
  const [warm, setWarm] = useState(false);
  const [reservedHeight, setReservedHeight] = useState(0);
  const slot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = slot.current;
    if (!element) return;
    // Metadata reserves image space before download. Observe the visible slot so
    // cached neighbors also retain their space when activated without a load event.
    const observer = new ResizeObserver(([entry]) => {
      if (entry)
        setReservedHeight((current) =>
          Math.max(current, entry.contentRect.height),
        );
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  const selected = items[index];
  const nearby = new Set([
    index,
    (index - 1 + items.length) % items.length,
    (index + 1) % items.length,
  ]);
  return (
    <div
      ref={slot}
      className={
        selected?.kind === 'video'
          ? 'hidden'
          : 'flex w-full shrink-0 flex-col justify-center'
      }
      style={{ minHeight: `min(55dvh, ${String(reservedHeight)}px)` }}
    >
      {items.map((item, position) =>
        item.kind === 'photo' &&
        nearby.has(position) &&
        (position === index || warm || selected?.kind === 'video') ? (
          <div
            key={item.id}
            data-map-photo={position === index ? 'active' : 'preload'}
            className={position === index ? 'contents' : 'hidden'}
            aria-hidden={position !== index ? true : undefined}
          >
            <MapPhoto
              item={item}
              onLoad={() => {
                setWarm(true);
              }}
            />
          </div>
        ) : null,
      )}
    </div>
  );
}

export function JapanMapView({
  land,
  points,
  references = [],
  projection,
}: {
  land: string;
  points: MapItem[];
  references?: MapReference[];
  projection?: MapProjection;
}) {
  const container = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, MapPoint>());
  const moved = useRef(false);
  const initialized = useRef(false);
  const [size, setSize] = useState({ width: 760, height: 440 });
  const [camera, setCamera] = useState<MapCamera>(() =>
    fitMapPoints(points, size),
  );
  const [active, setActive] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [detailUnavailable, setDetailUnavailable] = useState(false);
  const [placesUnavailable, setPlacesUnavailable] = useState(false);
  const [detailAttempt, setDetailAttempt] = useState(0);
  const groups = useMemo(
    () => clusterMapPoints(points, camera.zoom),
    [points, camera.zoom],
  );

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const nextSize = {
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      };
      setSize(nextSize);
      if (!initialized.current) {
        const selected = points.find(
          (point) =>
            point.id === new URLSearchParams(location.search).get('media'),
        );
        setCamera(fitMapPoints(selected ? [selected] : points, nextSize));
        setActive(selected?.id ?? null);
        initialized.current = true;
        setReady(true);
      }
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [points]);

  useEffect(() => {
    function focusSelected() {
      const selected = points.find(
        (point) =>
          point.id === new URLSearchParams(location.search).get('media'),
      );
      setActive(selected?.id ?? null);
      if (selected) setCamera(fitMapPoints([selected], size));
    }
    window.addEventListener('popstate', focusSelected);
    window.addEventListener('hashchange', focusSelected);
    return () => {
      window.removeEventListener('popstate', focusSelected);
      window.removeEventListener('hashchange', focusSelected);
    };
  }, [points, size]);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    function wheel(event: WheelEvent) {
      // Preserve ordinary page scrolling; Ctrl/Command + scroll zooms the map.
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      if (!element) return;
      const bounds = element.getBoundingClientRect();
      const unit =
        event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1;
      const factor =
        2 ** (-Math.max(-240, Math.min(240, event.deltaY * unit)) / 240);
      setActive(null);
      setCamera((current) =>
        zoomMapAt(current, factor, {
          x: event.clientX - bounds.left - size.width / 2,
          y: event.clientY - bounds.top - size.height / 2,
        }),
      );
    }
    element.addEventListener('wheel', wheel, { passive: false });
    return () => {
      element.removeEventListener('wheel', wheel);
    };
  }, [size]);

  function zoomBy(factor: number, anchor?: MapPoint) {
    setActive(null);
    setCamera((current) => zoomMapAt(current, factor, anchor));
  }

  return (
    <div
      ref={container}
      className="map-wrap relative h-[390px] scroll-mt-28 overflow-hidden bg-background text-foreground [background-image:radial-gradient(color-mix(in_srgb,var(--foreground)_15%,transparent)_0.75px,transparent_0.75px)] [background-size:8px_8px] min-[601px]:h-[440px]"
      id="japan-map"
      data-feedback-id="japan-map"
      data-zoom={camera.zoom}
    >
      <svg
        className="size-full touch-none cursor-grab active:cursor-grabbing"
        viewBox={`0 0 ${String(size.width)} ${String(size.height)}`}
        aria-label="Japan media map"
        role="group"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (['+', '=', '-'].includes(event.key)) {
            event.preventDefault();
            zoomBy(event.key === '-' ? 0.5 : 2);
          }
          const direction = {
            ArrowLeft: [-1, 0],
            ArrowRight: [1, 0],
            ArrowUp: [0, -1],
            ArrowDown: [0, 1],
          }[event.key];
          if (direction) {
            event.preventDefault();
            setActive(null);
            setCamera((current) => ({
              ...current,
              x: current.x + ((direction[0] ?? 0) * 60) / current.zoom,
              y: current.y + ((direction[1] ?? 0) * 60) / current.zoom,
            }));
          }
        }}
        onPointerDown={(event) => {
          if (
            event.button !== 0 ||
            !(event.target instanceof Element) ||
            !event.currentTarget.contains(event.target) ||
            event.target.closest('button, a')
          )
            return;
          // Pointer capture keeps panning active but does not stop native text
          // selection. Cancel that default only for canvas gestures, then keep
          // the map focusable for keyboard pan/zoom after a pointer interaction.
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          pointers.current.set(event.pointerId, {
            x: event.clientX,
            y: event.clientY,
          });
          moved.current = false;
        }}
        onPointerMove={(event) => {
          const previous = pointers.current.get(event.pointerId);
          if (!previous) return;
          const next = { x: event.clientX, y: event.clientY };
          const other = [...pointers.current.entries()].find(
            ([id]) => id !== event.pointerId,
          )?.[1];
          const bounds = event.currentTarget.getBoundingClientRect();
          pointers.current.set(event.pointerId, next);
          moved.current = true;
          setActive(null);
          setCamera((current) => {
            const oldMid = other
              ? { x: (previous.x + other.x) / 2, y: (previous.y + other.y) / 2 }
              : previous;
            const newMid = other
              ? { x: (next.x + other.x) / 2, y: (next.y + other.y) / 2 }
              : next;
            const factor = other
              ? Math.hypot(next.x - other.x, next.y - other.y) /
                Math.max(
                  1,
                  Math.hypot(previous.x - other.x, previous.y - other.y),
                )
              : 1;
            const zoom = Math.max(
              MIN_MAP_ZOOM,
              Math.min(MAX_MAP_ZOOM, current.zoom * factor),
            );
            return {
              zoom,
              x:
                current.x +
                (oldMid.x - bounds.left - size.width / 2) / current.zoom -
                (newMid.x - bounds.left - size.width / 2) / zoom,
              y:
                current.y +
                (oldMid.y - bounds.top - size.height / 2) / current.zoom -
                (newMid.y - bounds.top - size.height / 2) / zoom,
            };
          });
        }}
        onPointerUp={(event) => {
          pointers.current.delete(event.pointerId);
        }}
        onPointerCancel={(event) => {
          pointers.current.delete(event.pointerId);
        }}
        onDoubleClick={(event) => {
          if (
            !moved.current &&
            event.target instanceof Element &&
            event.currentTarget.contains(event.target) &&
            !event.target.closest('button, a')
          ) {
            const bounds = event.currentTarget.getBoundingClientRect();
            zoomBy(2, {
              x: event.clientX - bounds.left - size.width / 2,
              y: event.clientY - bounds.top - size.height / 2,
            });
          }
        }}
      >
        <path
          className="fill-background stroke-foreground [stroke-width:0.8] dark:fill-muted"
          vectorEffect="non-scaling-stroke"
          transform={`translate(${String(size.width / 2)} ${String(size.height / 2)}) scale(${String(camera.zoom)}) translate(${String(-camera.x)} ${String(-camera.y)})`}
          strokeLinejoin="round"
          d={land}
        />
        {projection && ready && (
          <MapContext
            camera={camera}
            size={size}
            projection={projection}
            onUnavailable={setDetailUnavailable}
            revision={detailAttempt}
          />
        )}
        {projection && ready && camera.zoom >= 16 && (
          <MapPlaceLabels
            camera={camera}
            size={size}
            projection={projection}
            pins={groups}
            onUnavailable={setPlacesUnavailable}
            revision={detailAttempt}
          />
        )}
        {references.map((reference) => {
          const x = (reference.x - camera.x) * camera.zoom + size.width / 2;
          const y = (reference.y - camera.y) * camera.zoom + size.height / 2;
          if (
            (projection && camera.zoom >= 16) ||
            camera.zoom < reference.minZoom ||
            x < 55 ||
            x > size.width - 85 ||
            y < 18 ||
            y > size.height - 18
          )
            return null;
          // Media pins and their place names take priority over reference labels.
          if (
            groups.some(
              (group) =>
                Math.abs((group.x - reference.x) * camera.zoom) < 95 &&
                Math.abs((group.y - reference.y) * camera.zoom) < 30,
            )
          )
            return null;
          return (
            <g
              key={reference.name}
              data-map-context={reference.kind}
              className="pointer-events-none fill-foreground/60"
            >
              {reference.kind === 'city' && <circle cx={x} cy={y} r="2" />}
              <text
                x={x + (reference.kind === 'city' ? 7 : 0)}
                y={y + 3}
                textAnchor={reference.kind === 'city' ? 'start' : 'middle'}
                className="stroke-background font-mono text-[10px] [paint-order:stroke] [stroke-width:3]"
              >
                {reference.name}
              </text>
            </g>
          );
        })}
        {groups.map((group) => {
          const x = (group.x - camera.x) * camera.zoom + size.width / 2;
          const y = (group.y - camera.y) * camera.zoom + size.height / 2;
          const index = Math.max(
            0,
            group.items.findIndex((item) => item.id === active),
          );
          const selected = group.items[index];
          if (
            !selected ||
            x < 22 ||
            y < 22 ||
            x > size.width - 22 ||
            y > size.height - 22
          )
            return null;
          return (
            <Popover
              key={group.items[0]?.id}
              open={group.items.some((item) => item.id === active)}
              onOpenChange={(open, details) => {
                if (!open && details.reason === 'trigger-press') {
                  details.cancel();
                  return;
                }
                setActive(open ? selected.id : null);
              }}
            >
              <foreignObject
                x={x - 22}
                y={y - 22}
                width="44"
                height="44"
                overflow="visible"
              >
                <PopoverTrigger
                  disabled={!ready}
                  className="map-marker flex size-11 items-center justify-center rounded-full border-[1.5px] border-background bg-foreground p-0 text-xs text-white outline-none select-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  aria-label={`${group.items[0]?.place || 'location'}, ${String(group.items.length)} items`}
                >
                  {group.items.length}
                </PopoverTrigger>
              </foreignObject>
              <text
                className="pointer-events-none fill-foreground stroke-background font-mono text-[11px] [paint-order:stroke] [stroke-width:3]"
                x={x + 26}
                y={y + 4}
              >
                {group.items[0]?.place}
              </text>
              <PopoverContent
                className="map-detail data-open:animate-none data-closed:animate-none relative max-h-[calc(100dvh-7rem)] w-[min(640px,calc(100vw-32px))] gap-3 overflow-y-auto rounded-none border border-border bg-background p-3 text-foreground shadow-none ring-0"
                side="bottom"
                align="center"
                sideOffset={10}
                data-feedback-id="map-preview"
              >
                <div className="flex items-center justify-between gap-3">
                  <PopoverTitle className="font-normal">
                    {selected.place} / {index + 1} of {group.items.length}
                  </PopoverTitle>
                  <Button
                    className={controlClass}
                    aria-label="Close map preview"
                    onClick={() => {
                      setActive(null);
                    }}
                  >
                    ×
                  </Button>
                </div>
                {selected.kind === 'video' ? (
                  <video
                    data-visibility-video
                    muted
                    loop
                    key={selected.id}
                    src={selected.src}
                    poster={selected.poster}
                    aria-label={selected.title}
                    controls
                    playsInline
                    preload="none"
                    className="block h-auto max-h-[55dvh] w-auto max-w-full shrink-0 self-center object-contain"
                  />
                ) : null}
                {active === selected.id && (
                  <MapPhotos items={group.items} index={index} />
                )}
                <div className="flex items-center justify-between gap-3">
                  <Button
                    className={controlClass}
                    disabled={group.items.length < 2}
                    aria-label="Previous media at this location"
                    onClick={() => {
                      setActive(
                        group.items[
                          (index - 1 + group.items.length) % group.items.length
                        ]?.id ?? null,
                      );
                    }}
                  >
                    ←
                  </Button>
                  <a
                    className={buttonVariants({
                      variant: 'link',
                      className: 'h-auto p-0 text-foreground',
                    })}
                    href={`/media/${selected.slug || selected.id}`}
                  >
                    VIEW MEDIA →
                  </a>
                  <Button
                    className={controlClass}
                    disabled={group.items.length < 2}
                    aria-label="Next media at this location"
                    onClick={() => {
                      setActive(
                        group.items[(index + 1) % group.items.length]?.id ??
                          null,
                      );
                    }}
                  >
                    →
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          );
        })}
      </svg>
      <div
        className="absolute right-3 bottom-3 flex flex-col gap-2"
        role="group"
        aria-label="Map controls"
      >
        <div className="hidden flex-col border border-border bg-background shadow-sm min-[601px]:flex">
          <Button
            className={`${controlClass} rounded-none border-0 border-b border-border`}
            disabled={!ready || camera.zoom >= MAX_MAP_ZOOM}
            aria-label="Zoom in"
            title="Zoom in"
            onClick={() => {
              zoomBy(2);
            }}
          >
            <Plus aria-hidden="true" />
          </Button>
          <Button
            className={`${controlClass} rounded-none border-0`}
            disabled={!ready || camera.zoom <= MIN_MAP_ZOOM}
            aria-label="Zoom out"
            title="Zoom out"
            onClick={() => {
              zoomBy(0.5);
            }}
          >
            <Minus aria-hidden="true" />
          </Button>
        </div>
      </div>
      {projection && (
        <a
          href="https://github.com/gsi-cyberjapan/optimal_bvmap"
          target="_blank"
          rel="noreferrer"
          className="absolute bottom-2 left-3 bg-background/90 text-[10px] text-foreground underline"
          aria-label="Map source: GSI Japan, custom vector style"
        >
          map data: gsi japan · styled
        </a>
      )}
      {projection && (detailUnavailable || placesUnavailable) && (
        <div className="absolute top-3 left-3 flex items-center gap-2 bg-background/90 px-2 py-1 text-[10px]">
          <span role="status">map detail unavailable</span>
          <Button
            variant="link"
            className="h-auto p-0 text-[10px]"
            onClick={() => {
              setDetailUnavailable(false);
              setPlacesUnavailable(false);
              setDetailAttempt((attempt) => attempt + 1);
            }}
          >
            RETRY MAP
          </Button>
        </div>
      )}
      <span
        className={`pointer-events-none absolute left-3 hidden text-[10px] text-foreground/60 min-[601px]:block ${projection ? 'bottom-7' : 'bottom-3'}`}
      >
        ctrl / ⌘ + scroll to zoom
      </span>
      {!points.length && (
        <span className="absolute top-3 left-3">no photos near japan yet</span>
      )}
    </div>
  );
}
