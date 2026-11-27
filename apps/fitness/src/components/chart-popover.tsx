import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent,
  PointerEvent,
  ReactNode,
  Ref,
  RefObject,
} from "react";

/** How a popover row's key looks: the chart line, a dashed line or a bar. */
type ChartMarker = "line" | "dash" | "bar" | "target";

/** What the popover shows for one point. */
export type ChartDetail = {
  title: string;
  rows: { label: string; value: string; marker?: ChartMarker }[];
};

/** The index of the point whose x is closest to `x`, or null without points. */
export function nearestIndex(xs: number[], x: number) {
  let best: number | null = null;
  for (const [index, value] of xs.entries())
    if (best === null || Math.abs(value - x) < Math.abs((xs[best] ?? 0) - x))
      best = index;
  return best;
}

/**
 * Where the popover goes inside its chart: beside the point, on the right
 * when it fits and otherwise on the left, level with the point, and always
 * within the chart's width and height when the card is smaller than them.
 */
export function placeCard({
  anchorX,
  anchorY,
  cardWidth,
  cardHeight,
  width,
  height,
  gap = 12,
}: {
  anchorX: number;
  anchorY: number;
  cardWidth: number;
  cardHeight: number;
  width: number;
  height: number;
  gap?: number;
}) {
  const clamp = (value: number, max: number) =>
    Math.max(0, Math.min(value, Math.max(0, max)));
  const right = anchorX + gap;
  const left =
    right + cardWidth <= width ? right : anchorX - gap - cardWidth;
  return {
    left: clamp(left, width - cardWidth),
    top: clamp(anchorY - cardHeight / 2, height - cardHeight),
  };
}

/** The next selected index for a key, or undefined when the key does nothing. */
export function keySelection(
  key: string,
  selected: number | null,
  count: number,
): number | null | undefined {
  if (!count) return undefined;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return selected === null ? 0 : Math.min(count - 1, selected + 1);
    case "ArrowLeft":
    case "ArrowUp":
      return selected === null ? count - 1 : Math.max(0, selected - 1);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    case "Escape":
      return selected === null ? undefined : null;
    default:
      return undefined;
  }
}

/** The popover's text as one sentence, for screen readers. */
export function spokenDetail(detail: ChartDetail) {
  return `${detail.title}: ${detail.rows.map((row) => `${row.label} ${row.value}`).join(", ")}.`;
}

/** The card a chart shows for its selected point. */
export function ChartCard({
  detail,
  cardRef,
  style,
}: {
  detail: ChartDetail;
  cardRef?: Ref<HTMLDivElement>;
  style?: CSSProperties;
}) {
  return (
    <div className="chart-card" ref={cardRef} style={style} aria-hidden="true">
      <p className="chart-card-title">{detail.title}</p>
      <dl>
        {detail.rows.map((row) => (
          <div key={row.label}>
            <dt>
              {row.marker && (
                <i className={`chart-marker is-${row.marker}`} />
              )}
              {row.label}
            </dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * What a touch has turned into once it moves: still a possible tap, a
 * sideways scrub that selects points, or a vertical scroll the page handles.
 */
export function touchIntent(dx: number, dy: number, slop = 8) {
  if (Math.abs(dx) < slop && Math.abs(dy) < slop) return "pending";
  return Math.abs(dx) > Math.abs(dy) ? "scrub" : "scroll";
}

/**
 * Keeps an open card beside its anchor, a point in viewport coordinates,
 * and places it again whenever the chart or the card changes size.
 */
export function useCardPlacement(
  frame: RefObject<HTMLElement | null>,
  card: RefObject<HTMLElement | null>,
  anchor: (() => { x: number; y: number } | undefined) | undefined,
) {
  const latest = useRef(anchor);
  latest.current = anchor;
  const place = useRef(() => {
    const at = latest.current?.();
    if (!at || !frame.current || !card.current) return;
    const box = frame.current.getBoundingClientRect();
    const { left, top } = placeCard({
      anchorX: at.x - box.left,
      anchorY: at.y - box.top,
      cardWidth: card.current.offsetWidth,
      cardHeight: card.current.offsetHeight,
      width: box.width,
      height: box.height,
    });
    card.current.style.transform = `translate(${left}px, ${top}px)`;
  });
  useLayoutEffect(() => place.current());
  const open = Boolean(anchor);
  useEffect(() => {
    if (!open || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => place.current());
    for (const element of [frame.current, card.current])
      if (element) observer.observe(element);
    return () => observer.disconnect();
  }, [open, frame, card]);
}

/**
 * Closes an open card on Escape, wherever focus is, and on a press outside
 * the chart.
 */
export function useDismiss(
  open: boolean,
  close: () => void,
  frame: RefObject<HTMLElement | null>,
) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") latest.current();
    };
    const onPress = (event: globalThis.PointerEvent) => {
      if (!frame.current?.contains(event.target as Node)) latest.current();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPress);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPress);
    };
  }, [open, frame]);
}

/**
 * An SVG chart that shows a cursor and a popover for the point nearest the
 * pointer. Hover over it, or tap it or drag sideways across it on a touch
 * screen; a vertical drag scrolls the page. A slider over the chart takes
 * keyboard focus: the arrow keys, Home and End move between points and
 * screen readers read each one. Escape, a press elsewhere, moving focus
 * away or moving the mouse off the chart hides the popover; the popover
 * stays while the pointer is over it. `points` are in the SVG's viewBox units.
 */
export function ChartPopover({
  width,
  height,
  points,
  detail,
  label,
  name,
  className,
  plot = { top: 0, bottom: height },
  children,
}: {
  width: number;
  height: number;
  points: { x: number; y: number }[];
  detail: (index: number) => ChartDetail;
  /** The chart's summary, read as the image's name. */
  label: string;
  /** What the points are, such as "Weigh-ins", read as the slider's name. */
  name: string;
  className: string;
  /** The cursor's vertical extent, in viewBox units. */
  plot?: { top: number; bottom: number };
  children: ReactNode;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const touch = useRef<{
    id: number;
    x: number;
    y: number;
    before: number | null;
    scrubbing: boolean;
  } | null>(null);
  // Whether the mouse made the selection, so leaving the chart clears only that.
  const byMouse = useRef(false);
  const hint = useId();
  const point = selected === null ? undefined : points[selected];
  const shown = point && selected !== null ? detail(selected) : undefined;

  useCardPlacement(
    frame,
    card,
    point
      ? () => {
          const matrix = svg.current?.getScreenCTM();
          return matrix
            ? new DOMPoint(point.x, point.y).matrixTransform(matrix)
            : undefined;
        }
      : undefined,
  );
  useDismiss(selected !== null, () => setSelected(null), frame);

  const nearest = (event: PointerEvent<SVGSVGElement>) => {
    const matrix = svg.current?.getScreenCTM()?.inverse();
    if (!matrix) return selected;
    const at = new DOMPoint(event.clientX, event.clientY).matrixTransform(
      matrix,
    );
    return nearestIndex(
      points.map((p) => p.x),
      at.x,
    );
  };

  const choose = (event: PointerEvent<SVGSVGElement>) => {
    byMouse.current = event.pointerType === "mouse";
    setSelected(nearest(event));
  };

  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.pointerType !== "touch") return choose(event);
    // A touch selects on release, or once it moves sideways.
    touch.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      before: selected,
      scrubbing: false,
    };
  };

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (event.pointerType !== "touch") return choose(event);
    const current = touch.current;
    if (!current || current.id !== event.pointerId) return;
    if (!current.scrubbing) {
      const intent = touchIntent(
        event.clientX - current.x,
        event.clientY - current.y,
      );
      if (intent === "pending") return;
      if (intent === "scroll") {
        touch.current = null;
        return;
      }
      current.scrubbing = true;
    }
    choose(event);
  };

  const onPointerUp = (event: PointerEvent<SVGSVGElement>) => {
    const current = touch.current;
    if (!current || current.id !== event.pointerId) return;
    touch.current = null;
    if (!current.scrubbing) choose(event);
  };

  const onPointerCancel = (event: PointerEvent<SVGSVGElement>) => {
    const current = touch.current;
    if (!current || current.id !== event.pointerId) return;
    touch.current = null;
    setSelected(current.before);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = keySelection(event.key, selected, points.length);
    if (next === undefined) return;
    event.preventDefault();
    byMouse.current = false;
    setSelected(next);
  };

  return (
    <div
      className="chart-frame"
      ref={frame}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse" && byMouse.current) setSelected(null);
      }}
    >
      <svg
        ref={svg}
        className={className}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={label}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        {children}
        {point && (
          <g className="chart-cursor" aria-hidden="true">
            <line x1={point.x} x2={point.x} y1={plot.top} y2={plot.bottom} />
            <circle cx={point.x} cy={point.y} r="6.5" />
          </g>
        )}
      </svg>
      <div
        className="chart-slider"
        role="slider"
        tabIndex={0}
        aria-label={name}
        aria-describedby={hint}
        aria-valuemin={0}
        aria-valuemax={points.length}
        aria-valuenow={(selected ?? -1) + 1}
        aria-valuetext={shown ? spokenDetail(shown) : "No point selected"}
        onKeyDown={onKeyDown}
        onBlur={() => setSelected(null)}
      />
      <p id={hint} className="visually-hidden">
        Use the left and right arrow keys to read each point.
      </p>
      {shown && <ChartCard detail={shown} cardRef={card} />}
    </div>
  );
}
