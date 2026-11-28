import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, PointerEvent } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@bent/ui/sdk/button";
import {
  formatDate,
  formatShortDate,
  settingsId,
} from "@bent/fitness-contracts/domain";
import type { Settings } from "@bent/fitness-contracts/domain";
import {
  canReorganise,
  canResetWeek,
  movableDays,
  planWeek,
  reorderPreview,
  reorderWeek,
  resetWeek,
  weekDays,
  weekSlots,
} from "@bent/fitness-contracts/week";
import type { WeekSlot } from "@bent/fitness-contracts/week";
import { useAccount } from "./account-context";
import { Icon } from "./icons";

/** The plan and week the sheet opened with. A save always targets this week. */
type Origin = { settings: Settings; revision: number; days: string[] };

/** "Mon 30" for a list row. */
const rowDay = (day: string) =>
  formatShortDate(day).split(" ").slice(0, 2).join(" ");

/**
 * Rearranges this week's planned sessions by dragging them between days, or
 * resets the week to the repeating plan. The sheet keeps the plan it opened
 * with, saves the new arrangement in one change, and refuses it when another
 * device changed the plan in the meantime.
 */
export function ReorganiseWeek({ monday }: { monday: string }) {
  const { sync, settings, today } = useAccount();
  const dialog = useRef<HTMLDialogElement>(null);
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [picked, setPicked] = useState<string>();
  // Save waits for a drag to end, so it never stores an unfinished move.
  const [dragActive, setDragActive] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const days = weekDays(monday);
  const movable = movableDays(days, today, sync.records);
  useEffect(() => {
    const element = dialog.current;
    return () => element?.close();
  }, []);
  // A different week, from browser history or a link, closes the sheet
  // and its unsaved arrangement.
  useEffect(() => {
    dialog.current?.close();
  }, [monday]);
  const preview = origin
    ? reorderPreview(origin.settings, origin.days, order)
    : "";
  return (
    <div className="reorganise-week">
      <Button
        className="text-link"
        disabled={!canReorganise(settings, movable)}
        onClick={() => {
          const latest = sync.latest(settingsId);
          if (latest.data?.kind !== "settings") return;
          setOrigin({
            settings: latest.data,
            revision: latest.revision,
            days,
          });
          setOrder(days);
          setPicked(undefined);
          setDragActive(false);
          setAnnouncement("");
          setError("");
          dialog.current?.showModal();
        }}
      >
        Reorganise week
      </Button>
      <Button
        className="text-link"
        disabled={!canResetWeek(settings, days)}
        onClick={() => {
          if (
            !window.confirm(
              "Reset this week to the repeating schedule? Recorded workouts and runs will stay unchanged.",
            )
          )
            return;
          const latest = sync.latest(settingsId);
          if (latest.data?.kind !== "settings") return;
          if (
            sync.put(resetWeek(latest.data, days), settingsId, latest.revision)
          )
            setNotice(
              "Week reset. Check the saving status above for cloud confirmation.",
            );
        }}
      >
        Reset week to repeating plan
      </Button>
      <p role="status">{notice}</p>
      <dialog
        ref={dialog}
        className="sheet"
        aria-labelledby="reorganise-title"
        onCancel={(event) => {
          // Escape first puts a selected session back and keeps the draft.
          if (!picked) return;
          event.preventDefault();
          setPicked(undefined);
          setAnnouncement("Move cancelled.");
        }}
        onClose={() => setOrigin(null)}
      >
        <div className="sheet-body">
          <div className="sheet-head">
            <h2 id="reorganise-title">Reorganise week</h2>
            <Button
              className="icon-button"
              aria-label="Close reorganisation"
              onClick={() => dialog.current?.close()}
            >
              <Icon name="close" />
            </Button>
          </div>
          {origin && (
            <WeekOrder
              slots={weekSlots(
                origin.settings,
                origin.days,
                order,
                today,
                sync.records,
              )}
              title={`${formatShortDate(origin.days[0] ?? monday)} – ${formatShortDate(origin.days[6] ?? monday)}`}
              picked={picked}
              onPick={setPicked}
              onAnnounce={setAnnouncement}
              onRestore={setOrder}
              onDragChange={setDragActive}
              onMove={(slots, source, destination) => {
                setOrder(
                  reorderWeek(
                    slots.map((slot) => slot.source),
                    slots.map((slot) => slot.locked),
                    [source],
                    destination,
                  ),
                );
                setError("");
              }}
            />
          )}
          <p className="visually-hidden" aria-live="polite">
            {announcement}
          </p>
          <form
            className="reorganise-actions"
            onSubmit={(event) => {
              event.preventDefault();
              if (!origin || dragActive) return;
              const result = planWeek(
                origin,
                sync.latest(settingsId),
                origin.days,
                order,
                today,
                sync.records,
              );
              if ("error" in result) {
                setError(result.error);
                return;
              }
              if (sync.put(result.settings, settingsId, origin.revision)) {
                setNotice(
                  "Week updated. Check the saving status above for cloud confirmation.",
                );
                dialog.current?.close();
              } else
                setError(
                  "The change could not be queued. Resolve the saving message above and try again.",
                );
            }}
          >
            {error && <p role="alert">{error}</p>}
            <p className="move-preview" aria-live="polite">
              {preview || "No changes yet."}
            </p>
            <Button
              type="submit"
              appearance="primary"
              disabled={!preview || dragActive}
            >
              Save week
            </Button>
          </form>
          <Button
            render={
              <Link
                to="/schedule"
                search={{}}
                onClick={() => dialog.current?.close()}
              />
            }
          >
            Edit the repeating schedule →
          </Button>
        </div>
      </dialog>
    </div>
  );
}

/** The nearest ancestor that scrolls vertically, such as the sheet. */
function scrollParent(element: HTMLElement | null) {
  for (let node = element?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight
    )
      return node;
  }
  return null;
}

/** How close to a scrolling edge a drag starts scrolling, in pixels. */
const scrollEdge = 56;
/** How far a press moves before it becomes a drag, in pixels. */
const dragThreshold = 6;

type Press = { source: string; pointer: number; x: number; y: number };

/**
 * The week as a list. Open days have a handle: drag it with a mouse or
 * touch, select it and then another day's handle, or use the arrow keys.
 * Past days and days with a recorded or started session show a lock and
 * stay where they are.
 */
function WeekOrder({
  slots,
  title,
  picked,
  onPick,
  onAnnounce,
  onRestore,
  onDragChange,
  onMove,
}: {
  slots: WeekSlot[];
  title: string;
  picked: string | undefined;
  onPick: (source: string | undefined) => void;
  onAnnounce: (message: string) => void;
  onRestore: (order: string[]) => void;
  onDragChange: (active: boolean) => void;
  onMove: (slots: WeekSlot[], source: number, destination: number) => void;
}) {
  const list = useRef<HTMLOListElement>(null);
  const handles = useRef(new Map<string, HTMLButtonElement>());
  const [dragging, setDragging] = useState<string>();
  const focusAfterMove = useRef("");
  // Pointer state the drag reads between renders and animation frames.
  const press = useRef<Press>(undefined);
  // A drag keeps the order it started from, to restore if it's cancelled.
  const drag = useRef<Press & { before: string[] }>(undefined);
  const frame = useRef(0);
  const ignoreClick = useRef(false);
  const current = useRef(slots);
  useLayoutEffect(() => {
    current.current = slots;
    if (!focusAfterMove.current) return;
    const handle = handles.current.get(focusAfterMove.current);
    handle?.focus();
    // Focus that stays on a moved handle doesn't scroll, so bring it into view.
    handle?.scrollIntoView({ block: "nearest" });
    focusAfterMove.current = "";
  });
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  // A press released anywhere, including outside the list, is over.
  useEffect(() => {
    const release = (event: globalThis.PointerEvent) => {
      if (press.current?.pointer === event.pointerId) press.current = undefined;
    };
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    return () => {
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
    };
  }, []);

  /** Moves the session at `from` to the row at `to`, as a drag onto that row would. */
  function moveTo(from: number, to: number) {
    const rows = current.current;
    const slot = rows[from];
    const target = rows[to];
    if (!slot || !target || from === to || slot.locked || target.locked) return;
    onMove(rows, from, to > from ? to + 1 : to);
    onAnnounce(`${slot.session} moved to ${formatDate(target.day)}.`);
  }

  function step(event: KeyboardEvent<HTMLButtonElement>, from: number) {
    const direction =
      event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    if (!direction) return;
    event.preventDefault();
    let to = from + direction;
    while (slots[to]?.locked) to += direction;
    if (!slots[to]) return;
    onPick(undefined);
    focusAfterMove.current = slots[from]?.source ?? "";
    moveTo(from, to);
  }

  /** Selecting a handle picks its session up; selecting another day's handle puts it there. */
  function choose(index: number, event: MouseEvent<HTMLElement>) {
    // Keyboard activation has no click count and is never the end of a drag.
    if (ignoreClick.current && event.detail > 0) {
      ignoreClick.current = false;
      return;
    }
    const slot = slots[index];
    if (!slot) return;
    if (!picked) {
      onPick(slot.source);
      onAnnounce(
        `${slot.session} selected. Choose the handle of the day to move it to.`,
      );
      return;
    }
    const from = slots.findIndex((item) => item.source === picked);
    onPick(undefined);
    if (from === index) {
      onAnnounce("Move cancelled.");
      return;
    }
    focusAfterMove.current = picked;
    moveTo(from, index);
  }

  /**
   * Places the dragged session on the day under the pointer. Only a row the
   * person can see counts, so the backdrop or the sheet's header never
   * chooses the day behind it.
   */
  function place(x: number, y: number) {
    const active = drag.current;
    if (!active) return;
    const row = document.elementFromPoint(x, y)?.closest("li");
    const to = row ? [...(list.current?.children ?? [])].indexOf(row) : -1;
    const from = current.current.findIndex(
      (slot) => slot.source === active.source,
    );
    if (to >= 0) moveTo(from, to);
  }

  /** Scrolls the sheet while a drag holds near its top or bottom edge. */
  function autoScroll() {
    const active = drag.current;
    if (!active) return;
    const scroller = scrollParent(list.current);
    if (scroller) {
      const box = scroller.getBoundingClientRect();
      const speed =
        active.y < box.top + scrollEdge
          ? -Math.ceil((box.top + scrollEdge - active.y) / 4)
          : active.y > box.bottom - scrollEdge
            ? Math.ceil((active.y - box.bottom + scrollEdge) / 4)
            : 0;
      if (speed) {
        scroller.scrollBy(0, speed);
        place(active.x, active.y);
      }
    }
    frame.current = requestAnimationFrame(autoScroll);
  }

  function pointerMove(event: PointerEvent<HTMLOListElement>) {
    const start = press.current;
    if (start && event.pointerId === start.pointer) {
      // A mouse released outside the list never reaches it; its next
      // movement here has no button held and starts nothing.
      if (event.pointerType === "mouse" && (event.buttons & 1) === 0) {
        press.current = undefined;
        return;
      }
      if (Math.abs(event.clientY - start.y) > dragThreshold) {
        const element = list.current;
        if (!element) return;
        press.current = undefined;
        drag.current = {
          ...start,
          x: event.clientX,
          y: event.clientY,
          before: current.current.map((slot) => slot.source),
        };
        element.setPointerCapture(event.pointerId);
        onPick(undefined);
        setDragging(start.source);
        onDragChange(true);
        frame.current = requestAnimationFrame(autoScroll);
      }
    }
    const active = drag.current;
    if (!active || event.pointerId !== active.pointer) return;
    active.x = event.clientX;
    active.y = event.clientY;
    place(event.clientX, event.clientY);
  }

  /**
   * Ends a drag. A release on the sheet keeps the new order; a release over
   * the backdrop, or a cancelled gesture, puts the week back as it was.
   */
  function pointerEnd(event: PointerEvent<HTMLOListElement>) {
    if (press.current?.pointer === event.pointerId) press.current = undefined;
    const active = drag.current;
    if (active?.pointer !== event.pointerId) return;
    drag.current = undefined;
    const sheet = list.current?.closest("dialog");
    const under = document.elementFromPoint(event.clientX, event.clientY);
    // The backdrop belongs to the dialog element itself.
    const dropped =
      event.type === "pointerup" &&
      Boolean(sheet && under && under !== sheet && sheet.contains(under));
    if (!dropped) {
      onRestore(active.before);
      onAnnounce("Move cancelled.");
    }
    cancelAnimationFrame(frame.current);
    setDragging(undefined);
    onDragChange(false);
    // The click that follows a drag doesn't select the handle.
    ignoreClick.current = true;
    setTimeout(() => {
      ignoreClick.current = false;
    }, 0);
    if (list.current?.hasPointerCapture(event.pointerId))
      list.current.releasePointerCapture(event.pointerId);
  }

  const pickedSlot = slots.find((slot) => slot.source === picked);
  return (
    <section className="week-order" aria-labelledby="week-order-title">
      <h3 id="week-order-title" className="section-label">
        {title}
      </h3>
      <ol
        ref={list}
        className={dragging ? "is-dragging" : undefined}
        onPointerMove={pointerMove}
        onPointerUp={pointerEnd}
        onPointerCancel={pointerEnd}
        onLostPointerCapture={(event) => {
          // A handle losing its implicit touch capture to the list isn't the end of a drag.
          if (event.target === event.currentTarget) pointerEnd(event);
        }}
      >
        {slots.map((slot, index) => (
          <li
            key={slot.source}
            className={[
              slot.locked && "is-locked",
              (dragging ?? picked) === slot.source && "is-lifted",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <span className="week-order-day">{rowDay(slot.day)}</span>
            <span className="week-order-session">
              {slot.session}
              {slot.locked && <span className="visually-hidden">, fixed</span>}
            </span>
            {slot.locked ? (
              <span className="week-order-lock">
                <Icon name="lock" size={16} />
              </span>
            ) : (
              <Button
                className="week-order-handle"
                ref={(element: HTMLButtonElement | null) => {
                  if (element) handles.current.set(slot.source, element);
                  else handles.current.delete(slot.source);
                }}
                aria-label={
                  !pickedSlot
                    ? `Move ${slot.session}, ${formatDate(slot.day)}`
                    : pickedSlot.source === slot.source
                      ? `Cancel moving ${slot.session}`
                      : `Move ${pickedSlot.session} to ${formatDate(slot.day)}`
                }
                aria-describedby="week-order-help"
                onClick={(event: MouseEvent<HTMLElement>) =>
                  choose(index, event)
                }
                onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) =>
                  step(event, index)
                }
                onPointerDown={(event: PointerEvent<HTMLButtonElement>) => {
                  // One pointer at a time: another finger can't take over a drag.
                  if (event.button !== 0 || press.current || drag.current)
                    return;
                  ignoreClick.current = false;
                  press.current = {
                    source: slot.source,
                    pointer: event.pointerId,
                    x: event.clientX,
                    y: event.clientY,
                  };
                }}
              >
                <Icon name="grip" size={18} />
              </Button>
            )}
          </li>
        ))}
      </ol>
      <p id="week-order-help" className="week-order-help">
        Drag a session by its handle to another day. You can also select a
        handle and then the handle of the day to move it to, or use the up and
        down arrow keys. The sessions in between shift to make room. Past days
        and recorded or started sessions stay fixed. This changes only this
        week.
      </p>
    </section>
  );
}
