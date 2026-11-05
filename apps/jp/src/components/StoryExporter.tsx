import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { z } from 'zod';
import { api } from '../lib/api-client';
import { loadStory, renderStory } from '../lib/story-renderer';
import { storySchema, type Story } from '../lib/story';
import { Button, buttonVariants } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Field, FieldLabel } from './ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import { Progress } from './ui/progress';

type Media = { id: string; day: string; title: string; poster: string };
const counterSchema = storySchema.shape.counter;
const perspectiveSchema = storySchema.shape.perspective;
export function StoryExporter({ media }: { media: Media[] }) {
  const days = [...new Set(media.map((item) => item.day))].sort().reverse();
  const [day, setDay] = useState(days[0] || '');
  const [selected, setSelected] = useState<string[]>(
    media
      .filter((item) => item.day === days[0])
      .slice(0, 15)
      .map((item) => item.id),
  );
  const [counter, setCounter] = useState<Story['counter']>('total');
  const [perspective, setPerspective] =
    useState<Story['perspective']>('angled');
  const [guides, setGuides] = useState(true);
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState(0);
  const [rendering, setRendering] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [download, setDownload] = useState<{ url: string; filename: string }>();
  const preview = useRef<HTMLDivElement>(null);
  const downloadLink = useRef<HTMLAnchorElement>(null);
  const renderer = useRef<Awaited<ReturnType<typeof loadStory>>>(undefined);
  const story = useRef<Story>(undefined);
  const abort = useRef<AbortController>(undefined);
  const drag = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
    active: boolean;
    target?: string;
  }>(undefined);
  const dragFrame = useRef<number>(undefined);
  const [dragging, setDragging] = useState<string>();
  const [dropTarget, setDropTarget] = useState<string>();
  const visible = media.filter((item) => item.day === day);
  const ordered = [
    ...selected.flatMap((id) => visible.filter((item) => item.id === id)),
    ...visible.filter((item) => !selected.includes(item.id)),
  ];
  function reorder(id: string, targetId: string) {
    setPlaying(false);
    setSelected((current) => {
      const index = current.indexOf(id);
      const target = current.indexOf(targetId);
      if (index < 0 || target < 0 || index === target) return current;
      const next = [...current];
      next.splice(index, 1);
      next.splice(target, 0, id);
      return next;
    });
  }
  function move(id: string, direction: -1 | 1) {
    const target = selected[selected.indexOf(id) + direction];
    if (target) reorder(id, target);
  }
  function cancelDrag() {
    drag.current = undefined;
    if (dragFrame.current !== undefined)
      cancelAnimationFrame(dragFrame.current);
    dragFrame.current = undefined;
    setDragging(undefined);
    setDropTarget(undefined);
  }
  function updateDragTarget() {
    const current = drag.current;
    if (!current?.active) return;
    const tile = document
      .elementFromPoint(current.x, current.y)
      ?.closest('[data-media-id]');
    const id = tile instanceof HTMLElement ? tile.dataset.mediaId : undefined;
    current.target = id && selected.includes(id) ? id : undefined;
    setDropTarget(current.target);
  }
  function scrollDrag() {
    const current = drag.current;
    if (!current?.active) return;
    const distance =
      current.y < 48
        ? current.y - 48
        : current.y > innerHeight - 48
          ? current.y - innerHeight + 48
          : 0;
    if (distance) window.scrollBy(0, Math.max(-16, Math.min(16, distance / 3)));
    updateDragTarget();
    dragFrame.current = requestAnimationFrame(scrollDrag);
  }
  function startDrag(event: PointerEvent<HTMLButtonElement>, id: string) {
    if (
      rendering ||
      selected.length < 2 ||
      event.button !== 0 ||
      !event.isPrimary
    )
      return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      active: false,
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
      setPlaying(false);
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
    updateDragTarget();
    cancelDrag();
    if (current.active && current.target) reorder(current.id, current.target);
  }
  useEffect(() => {
    cancelDrag();
    return () => {
      drag.current = undefined;
      if (dragFrame.current !== undefined)
        cancelAnimationFrame(dragFrame.current);
    };
  }, [day, selected, rendering]);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const isActive = () => !cancelled;
    story.current = undefined;
    setReady(false);
    if (!selected.length) {
      setStatus('select photos');
      return;
    }
    async function update() {
      const manifest = storySchema.parse(
        await api('/api/trip/story', {
          day,
          ids: selected,
          counter,
          perspective,
        }),
      );
      const loaded = await loadStory(manifest, controller.signal);
      if (!isActive()) {
        loaded.dispose();
        return;
      }
      renderer.current = loaded;
      story.current = manifest;
      await loaded.draw(0);
      if (isActive()) {
        preview.current?.replaceChildren(loaded.canvas);
        setReady(true);
        setStatus(`${String(selected.length)} selected`);
      }
    }
    void update().catch((error: unknown) => {
      if (isActive())
        setStatus(error instanceof Error ? error.message : 'Preview failed');
    });
    return () => {
      cancelled = true;
      controller.abort();
      renderer.current?.dispose();
      renderer.current = undefined;
      preview.current?.replaceChildren();
    };
  }, [day, selected, counter, perspective]);
  useEffect(() => {
    if (!playing || rendering) return;
    let frameId = 0,
      cancelled = false;
    const isActive = () => !cancelled;
    const started = performance.now();
    async function frame() {
      if (cancelled || !renderer.current) return;
      await renderer.current.draw((performance.now() - started) / 1000);
      if (isActive())
        frameId = requestAnimationFrame(() => {
          void frame();
        });
    }
    void frame().catch((error: unknown) => {
      setPlaying(false);
      setStatus(error instanceof Error ? error.message : 'Preview failed');
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frameId);
    };
  }, [playing, rendering]);
  useEffect(() => {
    if (download) downloadLink.current?.click();
  }, [download]);
  useEffect(
    () => () => {
      abort.current?.abort();
    },
    [],
  );
  async function exportStory(format: 'png' | 'mp4') {
    const manifest = story.current;
    if (!manifest || rendering) return;
    setPlaying(false);
    setRendering(true);
    setProgress(0);
    setStatus('rendering');
    const controller = new AbortController();
    abort.current = controller;
    try {
      const blob = await renderStory(
        manifest,
        format,
        (value) => {
          setProgress(value * 100);
          setStatus(`rendering ${String(Math.round(value * 100))}%`);
        },
        controller.signal,
      );
      controller.signal.throwIfAborted();
      setStatus('saving');
      const body = new FormData(),
        filename = `japan-story-${manifest.day}.${format}`;
      body.set('file', new File([blob], filename, { type: blob.type }));
      const response = await fetch('/api/trip/exports', {
        method: 'POST',
        headers: { 'X-EmDash-Request': '1' },
        body,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('Could not save export');
      const result = z.object({ url: z.string() }).parse(await response.json());
      controller.signal.throwIfAborted();
      setDownload({ url: result.url, filename });
      setStatus('ready');
    } catch (error) {
      setStatus(
        controller.signal.aborted
          ? 'cancelled'
          : error instanceof Error
            ? error.message
            : 'Export failed',
      );
    } finally {
      setRendering(false);
    }
  }
  return (
    <>
      <div className="mb-5 flex items-center justify-between gap-3">
        <h1>story export</h1>
        <span>1080 × 1920</span>
      </div>
      <div className="grid grid-cols-1 gap-10 min-[601px]:grid-cols-[minmax(0,1fr)_minmax(280px,420px)]">
        <div id="export-form" className="space-y-4">
          <Field>
            <FieldLabel htmlFor="story-day">day</FieldLabel>
            <Select
              value={day}
              disabled={rendering}
              items={days.map((value) => ({ value, label: value }))}
              onValueChange={(value) => {
                if (!value) return;
                setPlaying(false);
                setDay(value);
                setSelected(
                  media
                    .filter((item) => item.day === value)
                    .slice(0, 15)
                    .map((item) => item.id),
                );
              }}
            >
              <SelectTrigger id="story-day" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {days.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <p id="stack-order">stack order, back to front. drag ↕ to reorder</p>
          <div
            className="gallery-grid grid grid-cols-2 items-start gap-[7px] min-[901px]:grid-cols-3"
            id="export-selection"
            aria-describedby="stack-order"
          >
            {ordered.map((item) => (
              <div
                key={item.id}
                className="select-media relative data-[dragging=true]:opacity-50 data-[drop-target=true]:outline-2 data-[drop-target=true]:outline-offset-2"
                data-day={item.day}
                data-media-id={item.id}
                data-dragging={dragging === item.id}
                data-drop-target={
                  dropTarget === item.id && dragging !== item.id
                }
              >
                <Checkbox
                  id={`export-${item.id}`}
                  name="media"
                  value={item.id}
                  checked={selected.includes(item.id)}
                  disabled={
                    rendering ||
                    (!selected.includes(item.id) && selected.length >= 15)
                  }
                  className="absolute top-2.5 right-2.5 z-10 size-5 bg-background"
                  onCheckedChange={(checked) => {
                    setPlaying(false);
                    setSelected((current) =>
                      checked
                        ? [...current, item.id]
                        : current.filter((id) => id !== item.id),
                    );
                  }}
                />
                {selected.includes(item.id) && (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="outline"
                    className="absolute top-2.5 left-2.5 z-10 touch-none cursor-grab bg-background active:cursor-grabbing"
                    aria-label={`Drag ${item.title} to reorder`}
                    aria-describedby="stack-order"
                    disabled={rendering || selected.length < 2}
                    onPointerDown={(event) => {
                      startDrag(event, item.id);
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
                )}
                <FieldLabel htmlFor={`export-${item.id}`} className="m-0 block">
                  <img
                    src={item.poster}
                    alt={item.title}
                    draggable={false}
                    className="block h-auto w-full"
                  />
                  <span className="sr-only">{item.title}</span>
                </FieldLabel>
                {selected.includes(item.id) && (
                  <div className="flex flex-wrap items-center justify-between gap-1 border border-t-0 p-1">
                    <span
                      className="px-1"
                      aria-label={`Stack position ${String(selected.indexOf(item.id) + 1)} of ${String(selected.length)}`}
                    >
                      {selected.indexOf(item.id) + 1} / {selected.length}
                    </span>
                    <div className="flex gap-1">
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="outline"
                        aria-label={`Move ${item.title} toward back`}
                        disabled={rendering || selected[0] === item.id}
                        onClick={() => {
                          move(item.id, -1);
                        }}
                      >
                        ←
                      </Button>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="outline"
                        aria-label={`Move ${item.title} toward front`}
                        disabled={rendering || selected.at(-1) === item.id}
                        onClick={() => {
                          move(item.id, 1);
                        }}
                      >
                        →
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
          <Field>
            <FieldLabel htmlFor="story-counter">beer counter</FieldLabel>
            <Select
              value={counter}
              disabled={rendering}
              items={[
                { value: 'today', label: 'today' },
                { value: 'total', label: 'trip total' },
                { value: 'hidden', label: 'hidden' },
              ]}
              onValueChange={(value) => {
                const next = counterSchema.safeParse(value);
                if (next.success) {
                  setPlaying(false);
                  setCounter(next.data);
                }
              }}
            >
              <SelectTrigger id="story-counter" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="today">today</SelectItem>
                <SelectItem value="total">trip total</SelectItem>
                <SelectItem value="hidden">hidden</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="story-perspective">card angle</FieldLabel>
            <Select
              value={perspective}
              disabled={rendering}
              items={[
                { value: 'angled', label: 'right edge up' },
                { value: 'straight', label: 'no skew' },
              ]}
              onValueChange={(value) => {
                const next = perspectiveSchema.safeParse(value);
                if (next.success) {
                  setPlaying(false);
                  setPerspective(next.data);
                }
              }}
            >
              <SelectTrigger id="story-perspective" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="angled">right edge up</SelectItem>
                <SelectItem value="straight">no skew</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field orientation="horizontal">
            <Checkbox
              id="safe-areas"
              checked={guides}
              onCheckedChange={setGuides}
            />
            <FieldLabel htmlFor="safe-areas">safe area guides</FieldLabel>
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              id="play-preview"
              disabled={rendering || !ready || !selected.length}
              onClick={() => {
                setPlaying(!playing);
              }}
            >
              {playing ? 'PAUSE' : 'PLAY PREVIEW'}
            </Button>
            <Button
              variant="default"
              disabled={rendering || !ready || !selected.length}
              onClick={() => {
                void exportStory('mp4');
              }}
            >
              EXPORT MP4
            </Button>
            <Button
              disabled={rendering || !ready || !selected.length}
              onClick={() => {
                void exportStory('png');
              }}
            >
              EXPORT PNG
            </Button>
            {rendering && (
              <Button id="cancel-export" onClick={() => abort.current?.abort()}>
                CANCEL
              </Button>
            )}
          </div>
          {rendering && (
            <Progress value={progress} aria-label="Story export progress" />
          )}
          <p
            id="export-status"
            className="whitespace-pre-wrap empty:hidden"
            role="status"
          >
            {status}
          </p>
          {download && (
            <a
              ref={downloadLink}
              id="download"
              href={download.url}
              download={download.filename}
              className={buttonVariants()}
            >
              DOWNLOAD
            </a>
          )}
        </div>
        <div
          className="relative aspect-[9/16] w-full max-w-[360px] justify-self-center overflow-hidden bg-[#0647ff] text-white min-[601px]:max-w-none [&_canvas]:size-full"
          data-feedback-id="story-composition"
        >
          <div id="story-preview" ref={preview} />
          {guides && (
            <div className="story-guides pointer-events-none absolute inset-x-[6%] top-[14.6%] bottom-[19.8%] border border-dashed border-white/50" />
          )}
        </div>
      </div>
    </>
  );
}
