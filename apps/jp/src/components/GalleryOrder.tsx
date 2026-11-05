import { useEffect, useId, useRef, useState, type PointerEvent } from 'react';
import { Button } from './ui/button';

type GalleryItem = {
  id: string;
  data: {
    title: string;
    poster?: { src?: string } | null;
    poster_url?: string | null;
    asset?: { url?: string } | null;
    source_url?: string | null;
  };
};

function scrollableParent(element: HTMLElement | null) {
  for (
    let parent = element?.parentElement;
    parent && parent !== document.scrollingElement;
    parent = parent.parentElement
  ) {
    if (
      /^(auto|scroll|overlay)$/.test(getComputedStyle(parent).overflowY) &&
      parent.scrollHeight > parent.clientHeight
    )
      return parent;
  }
}

export function GalleryOrder({
  selected,
  items,
  onChange,
}: {
  selected: string[];
  items: GalleryItem[];
  onChange: (ids: string[]) => void;
}) {
  const instructions = useId();
  const container = useRef<HTMLOListElement>(null);
  const drag = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
    active: boolean;
    scrollElement?: HTMLElement;
    target?: string;
  }>(undefined);
  const frame = useRef<number>(undefined);
  const [dragging, setDragging] = useState<string>();
  const [dropTarget, setDropTarget] = useState<string>();
  const [announcement, setAnnouncement] = useState('');

  function reorder(id: string, targetId: string) {
    const from = selected.indexOf(id),
      to = selected.indexOf(targetId);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...selected];
    next.splice(from, 1);
    next.splice(to, 0, id);
    onChange(next);
    const item = items.find((item) => item.id === id);
    setAnnouncement(
      `${item?.data.title || 'media'} moved to ${String(to + 1)} of ${String(next.length)}`,
    );
  }
  function cancelDrag() {
    drag.current = undefined;
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
    setDragging(undefined);
    setDropTarget(undefined);
  }
  function updateTarget() {
    const current = drag.current;
    if (!current?.active) return;
    const tile = document
      .elementFromPoint(current.x, current.y)
      ?.closest('[data-gallery-id]');
    const id =
      tile instanceof HTMLElement && container.current?.contains(tile)
        ? tile.dataset.galleryId
        : undefined;
    current.target = id && selected.includes(id) ? id : undefined;
    setDropTarget(current.target);
  }
  function scrollDrag() {
    const current = drag.current;
    if (!current?.active) return;
    let top = 0,
      bottom = innerHeight;
    if (current.scrollElement) {
      const bounds = current.scrollElement.getBoundingClientRect();
      const contentTop = bounds.top + current.scrollElement.clientTop;
      top = Math.max(0, contentTop);
      bottom = Math.min(
        innerHeight,
        contentTop + current.scrollElement.clientHeight,
      );
    }
    const distance =
      current.y < top + 48
        ? current.y - top - 48
        : current.y > bottom - 48
          ? current.y - bottom + 48
          : 0;
    if (distance)
      (current.scrollElement || window).scrollBy(
        0,
        Math.max(-16, Math.min(16, distance / 3)),
      );
    updateTarget();
    frame.current = requestAnimationFrame(scrollDrag);
  }
  function startDrag(event: PointerEvent<HTMLButtonElement>, id: string) {
    if (selected.length < 2 || event.button !== 0 || !event.isPrimary) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      active: false,
      scrollElement: scrollableParent(container.current),
    };
  }
  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.x = event.clientX;
    current.y = event.clientY;
    if (
      !current.active &&
      Math.hypot(current.x - current.startX, current.y - current.startY) >= 6
    ) {
      current.active = true;
      setDragging(current.id);
      scrollDrag();
    }
    if (current.active) event.preventDefault();
  }
  function finishDrag(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.x = event.clientX;
    current.y = event.clientY;
    updateTarget();
    cancelDrag();
    if (current.active && current.target) reorder(current.id, current.target);
  }
  useEffect(() => {
    cancelDrag();
    return () => {
      drag.current = undefined;
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    };
  }, [selected]);

  if (!selected.length) return null;
  return (
    <div className="space-y-2">
      <p id={instructions}>gallery order. drag ↕ or move ↑ ↓</p>
      <ol
        ref={container}
        className="grid grid-cols-2 items-start gap-2 sm:grid-cols-3"
        aria-label="Post gallery"
        aria-describedby={instructions}
      >
        {selected.flatMap((id, index) => {
          const item = items.find((item) => item.id === id);
          return item
            ? [
                <li
                  key={id}
                  data-gallery-id={id}
                  data-dragging={dragging === id}
                  data-drop-target={dropTarget === id && dragging !== id}
                  className="relative min-w-0 border data-[dragging=true]:opacity-50 data-[drop-target=true]:outline-2 data-[drop-target=true]:outline-offset-2"
                >
                  <img
                    src={
                      item.data.poster?.src ||
                      item.data.poster_url ||
                      item.data.asset?.url ||
                      item.data.source_url ||
                      ''
                    }
                    alt={item.data.title}
                    draggable={false}
                    className="block h-auto w-full"
                  />
                  <Button
                    type="button"
                    size="icon"
                    className="absolute top-1 left-1 touch-none cursor-grab bg-background active:cursor-grabbing"
                    aria-label={`Drag ${item.data.title} to reorder`}
                    aria-describedby={instructions}
                    disabled={selected.length < 2}
                    onPointerDown={(event) => {
                      startDrag(event, id);
                    }}
                    onPointerMove={moveDrag}
                    onPointerUp={finishDrag}
                    onPointerCancel={cancelDrag}
                    onLostPointerCapture={cancelDrag}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') cancelDrag();
                    }}
                  >
                    ↕
                  </Button>
                  <div className="flex flex-wrap items-center justify-between gap-1 border-t p-1">
                    <span
                      className="px-1"
                      aria-label={`Gallery position ${String(index + 1)} of ${String(selected.length)}`}
                    >
                      {index + 1} / {selected.length}
                    </span>
                    <div className="flex gap-1">
                      <Button
                        type="button"
                        size="icon"
                        aria-label={`Move ${item.data.title} earlier`}
                        disabled={index === 0}
                        onClick={() => {
                          const target = selected[index - 1];
                          if (target) reorder(id, target);
                        }}
                      >
                        ↑
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        aria-label={`Move ${item.data.title} later`}
                        disabled={index === selected.length - 1}
                        onClick={() => {
                          const target = selected[index + 1];
                          if (target) reorder(id, target);
                        }}
                      >
                        ↓
                      </Button>
                    </div>
                  </div>
                </li>,
              ]
            : [];
        })}
      </ol>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </div>
  );
}
