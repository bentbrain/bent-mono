import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@bent/ui/button";
import {
  addDays,
  formatDate,
  reorganiseDays,
  sameData,
  scheduled,
  settingsId,
} from "../domain";
import type { Settings } from "../domain";
import { useAccount } from "./account-context";
import { Icon } from "./icons";

/** An explicit swap, with a snapshot guard for edits made on another device. */
export function ReorganiseWeek({ monday }: { monday: string }) {
  const { sync, settings, today } = useAccount();
  const dialog = useRef<HTMLDialogElement>(null);
  const [origin, setOrigin] = useState<{
    settings: Settings;
    revision: number;
  } | null>(null);
  const [notice, setNotice] = useState("");
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const locked = (day: string) =>
    day < today ||
    sync.records.some(
      ({ data }) =>
        (data.kind === "workout" || data.kind === "run") && data.date === day,
    );
  const movable = days.filter((day) => !locked(day));
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const element = dialog.current;
    return () => element?.close();
  }, []);
  const name = (plan: ReturnType<typeof scheduled>) =>
    plan.type === "strength"
      ? (plan.routine?.name ?? "Strength")
      : plan.type === "run"
        ? "Easy run"
        : "Rest";
  const preview =
    origin && from && to
      ? {
          source: scheduled(origin.settings, from),
          destination: scheduled(origin.settings, to),
        }
      : null;
  return (
    <div className="reorganise-week">
      <button
        type="button"
        className="text-link"
        disabled={
          movable.length < 2 ||
          !movable.some((day) => scheduled(settings, day).type !== "rest")
        }
        onClick={() => {
          const latest = sync.latest(settingsId);
          if (latest.data?.kind !== "settings") return;
          setOrigin({ settings: latest.data, revision: latest.revision });
          const source =
            movable.find(
              (day) =>
                scheduled(
                  latest.data?.kind === "settings" ? latest.data : settings,
                  day,
                ).type !== "rest",
            ) ?? "";
          setFrom(source);
          setTo(movable.find((day) => day !== source) ?? "");
          setError("");
          dialog.current?.showModal();
        }}
      >
        Reorganise week
      </button>
      <button
        type="button"
        className="text-link"
        disabled={!days.some((day) => settings.dayPlans?.[day])}
        onClick={() => {
          if (
            !window.confirm(
              "Reset this week to the repeating schedule? Recorded workouts and runs will stay unchanged.",
            )
          )
            return;
          const latest = sync.latest(settingsId);
          if (latest.data?.kind !== "settings") return;
          const next = {
            ...latest.data,
            dayPlans: Object.fromEntries(
              Object.entries(latest.data.dayPlans ?? {}).filter(
                ([day]) => !days.includes(day),
              ),
            ),
          };
          if (sync.put(next, settingsId, latest.revision))
            setNotice(
              "Week reset. Check the saving status above for cloud confirmation.",
            );
        }}
      >
        Reset week to repeating plan
      </button>
      <p role="status">{notice}</p>
      <dialog
        ref={dialog}
        className="sheet"
        aria-labelledby="reorganise-title"
        onClose={() => setOrigin(null)}
      >
        <div className="sheet-body">
          <div className="sheet-head">
            <h2 id="reorganise-title">Move a planned session</h2>
            <button
              type="button"
              className="icon-button"
              aria-label="Close reorganisation"
              onClick={() => dialog.current?.close()}
            >
              <Icon name="close" />
            </button>
          </div>
          <p>
            Choose where this session goes. If that day has a session, the two
            will swap. This changes only this week.
          </p>
          <p>Past days and recorded or started sessions stay fixed.</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!origin) return;
              const latest = sync.latest(settingsId);
              if (
                latest.revision !== origin.revision ||
                !sameData(latest.data, origin.settings)
              ) {
                setError(
                  "Your plan changed. Close this panel and reopen it to use the saved plan.",
                );
                return;
              }
              try {
                const next = reorganiseDays(
                  origin.settings,
                  from,
                  to,
                  today,
                  sync.records,
                );
                if (sync.put(next, settingsId, origin.revision)) {
                  setNotice(
                    "Week updated. Check the saving status above for cloud confirmation.",
                  );
                  dialog.current?.close();
                } else
                  setError(
                    "The change could not be queued. Resolve the saving message above and try again.",
                  );
              } catch (problem) {
                setError(
                  problem instanceof Error
                    ? problem.message
                    : "Check the selected days.",
                );
              }
            }}
          >
            <div>
              <label htmlFor="move-source">Session to move</label>
              <select
                id="move-source"
                value={from}
                onChange={(event) => {
                  setFrom(event.target.value);
                  if (to === event.target.value)
                    setTo(
                      movable.find((day) => day !== event.target.value) ?? "",
                    );
                  setError("");
                }}
              >
                {origin &&
                  movable
                    .filter(
                      (day) => scheduled(origin.settings, day).type !== "rest",
                    )
                    .map((day) => (
                      <option key={day} value={day}>
                        {formatDate(day)} ·{" "}
                        {name(scheduled(origin.settings, day))}
                      </option>
                    ))}
              </select>
            </div>
            <div>
              <label htmlFor="move-destination">Move to</label>
              <select
                id="move-destination"
                value={to}
                onChange={(event) => {
                  setTo(event.target.value);
                  setError("");
                }}
              >
                {origin &&
                  movable
                    .filter((day) => day !== from)
                    .map((day) => (
                      <option key={day} value={day}>
                        {formatDate(day)} ·{" "}
                        {name(scheduled(origin.settings, day))}
                      </option>
                    ))}
              </select>
            </div>
            {preview && (
              <p className="move-preview">
                {name(preview.source)} moves to {formatDate(to)}.{" "}
                {name(preview.destination)} moves to {formatDate(from)}.
              </p>
            )}
            {error && <p role="alert">{error}</p>}
            <Button
              type="submit"
              appearance="primary"
              disabled={!from || !to || from === to}
            >
              Apply move
            </Button>
          </form>
          <Link
            to="/schedule"
            search={{}}
            onClick={() => dialog.current?.close()}
          >
            Edit the repeating schedule →
          </Link>
        </div>
      </dialog>
    </div>
  );
}
