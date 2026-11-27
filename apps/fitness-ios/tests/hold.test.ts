import { describe, expect, test } from "bun:test";
import { createWorkout, defaultSettings } from "@bent/fitness-contracts/domain";
import type { Workout } from "@bent/fitness-contracts/domain";
import {
  holdEndsAt,
  holdPhase,
  holdResult,
  phaseAnnouncement,
  phaseKey,
  phaseTitle,
  readySeconds,
  startHold,
  targetSeconds,
} from "../src/screens/week/workout/hold";
import { activityContent, sameActivity } from "../src/screens/week/workout/activity";
import { applySetChange } from "../src/screens/week/workout/session";

const settings = defaultSettings("2026-01-05", "UTC");
const t0 = Date.parse("2026-01-05T07:10:00.000Z");
const s = (seconds: number) => t0 + seconds * 1000;

/** A synthetic workout with a plank, a side plank and a dumbbell exercise. */
function workout(): Workout {
  const routine = settings.routines[0];
  if (!routine) throw new Error("Missing template");
  const base = createWorkout(settings, routine, "2026-01-05", false, []);
  const plank = { name: "Forearm plank", id: "plank", sets: 2, min: 30, max: 45, side: false, rest: 60, mode: "seconds" as const };
  const sidePlank = { ...plank, id: "side-plank", name: "Side plank", min: 20, max: 30, side: true };
  const row = base.exercises.find((exercise) => exercise.prescription.mode === "reps");
  if (!row) throw new Error("Missing reps exercise");
  const sets = (p: typeof plank) =>
    Array.from({ length: p.sets }, () => ({ loadKg: 0, value: p.min, right: p.side ? p.min : null, done: false, skipped: false, rir: 3, controlled: true }));
  return { ...base, restUntil: null, exercises: [{ prescription: plank, sets: sets(plank) }, { prescription: sidePlank, sets: sets(sidePlank) }, row] };
}

describe("hold timer", () => {
  test("starts only for a timed set that is still to do", () => {
    const w = workout();
    expect(startHold(w, 0, 0, { seconds: 30, right: null }, t0)).toEqual({
      exerciseIndex: 0,
      setIndex: 0,
      name: "Forearm plank",
      startedAt: t0,
      seconds: 30,
      right: null,
    });
    expect(startHold(w, 2, 0, { seconds: 30, right: null }, t0)).toBeUndefined();
    expect(startHold(w, 0, 9, { seconds: 30, right: null }, t0)).toBeUndefined();
    const done = applySetChange(w, 0, 0, { done: true }, { startRest: false, now: t0 });
    expect(startHold(done, 0, 0, { seconds: 30, right: null }, t0)).toBeUndefined();
    // A side exercise holds the right side for the left target when none is given.
    expect(startHold(w, 1, 0, { seconds: 25, right: null }, t0)?.right).toBe(25);
  });

  test("counts down to get ready, then the hold", () => {
    const hold = startHold(workout(), 0, 0, { seconds: 30, right: null }, t0);
    if (!hold) throw new Error("No hold");
    expect(holdPhase(hold, s(0))).toEqual({ kind: "ready", side: null, endsAt: s(readySeconds) });
    expect(holdPhase(hold, s(readySeconds))).toEqual({ kind: "hold", side: null, startedAt: s(5), endsAt: s(35) });
    expect(holdPhase(hold, s(34.9)).kind).toBe("hold");
    expect(holdPhase(hold, s(35))).toEqual({ kind: "done" });
    expect(holdEndsAt(hold)).toBe(s(35));
  });

  test("holds each side in turn with a pause to switch", () => {
    const hold = startHold(workout(), 1, 0, { seconds: 20, right: 25 }, t0);
    if (!hold) throw new Error("No hold");
    const phases = [0, 5, 24, 25, 29, 30, 54, 55].map((at) => {
      const phase = holdPhase(hold, s(at));
      return phase.kind === "done" ? "done" : `${phase.kind}:${phase.side}`;
    });
    expect(phases).toEqual(["ready:left", "hold:left", "hold:left", "ready:right", "ready:right", "hold:right", "hold:right", "done"]);
    expect(phaseTitle(holdPhase(hold, s(25)))).toBe("Switch to right");
    expect(phaseAnnouncement(hold, holdPhase(hold, s(30)))).toBe("Hold right for 25 seconds.");
    expect(phaseKey(holdPhase(hold, s(26)))).toBe(phaseKey(holdPhase(hold, s(28))));
    expect(phaseKey(holdPhase(hold, s(26)))).not.toBe(phaseKey(holdPhase(hold, s(31))));
  });

  test("a finished hold records every target and marks the set Done", () => {
    const one = startHold(workout(), 0, 0, { seconds: 40, right: null }, t0);
    const both = startHold(workout(), 1, 1, { seconds: 20, right: 25 }, t0);
    if (!one || !both) throw new Error("No hold");
    expect(holdResult(one, holdEndsAt(one))).toEqual({ value: 40, done: true, skipped: false });
    expect(holdResult(both, holdEndsAt(both) + 60_000)).toEqual({ value: 20, right: 25, done: true, skipped: false });
    // Recording it starts the exercise's rest from the moment the hold ended.
    const recorded = applySetChange(workout(), 0, 0, holdResult(one, holdEndsAt(one)) ?? {}, { startRest: true, now: holdEndsAt(one) });
    expect(recorded.exercises[0]?.sets[0]).toMatchObject({ value: 40, done: true });
    expect(recorded.restUntil).toBe(holdEndsAt(one) + 60_000);
  });

  test("stopping early records whole seconds held and leaves the set open", () => {
    const one = startHold(workout(), 0, 0, { seconds: 40, right: null }, t0);
    const both = startHold(workout(), 1, 0, { seconds: 20, right: 25 }, t0);
    if (!one || !both) throw new Error("No hold");
    // Stopping while getting ready records nothing.
    expect(holdResult(one, s(3))).toBeUndefined();
    expect(holdResult(one, s(5.4))).toBeUndefined();
    expect(holdResult(one, s(17.9))).toEqual({ value: 12 });
    // The left side is complete while switching; the right side was not reached.
    expect(holdResult(both, s(27))).toEqual({ value: 20 });
    expect(holdResult(both, s(40.5))).toEqual({ value: 20, right: 10 });
  });

  test("reads targets from typed text, else the saved value", () => {
    expect(targetSeconds("45", 30)).toBe(45);
    expect(targetSeconds(" 60 ", 30)).toBe(60);
    expect(targetSeconds("", 30)).toBe(30);
    expect(targetSeconds("4.5", 30)).toBe(30);
    expect(targetSeconds("0", 30)).toBe(30);
    expect(targetSeconds("900", 30)).toBe(30);
    expect(targetSeconds("abc", 0)).toBe(1);
    expect(targetSeconds("", 700)).toBe(600);
  });
});

describe("workout Live Activity", () => {
  test("shows the next set while lifting", () => {
    const w = workout();
    const content = activityContent("w1", w, null, "kg", t0);
    expect(content).toMatchObject({
      workoutId: "w1",
      workoutName: w.name,
      startedAt: Date.parse(w.startedAt),
      staleAt: null,
      alert: null,
      state: {
        phase: "lift",
        title: "Forearm plank",
        exercise: "Forearm plank",
        detail: "Set 1 of 2 · 30 s hold",
        completed: 0,
        timerStart: null,
        timerEnd: null,
      },
    });
    // A weighted exercise shows the load and rep range; side exercises say each side.
    const lifted = [0, 1].reduce((value, ei) => [0, 1].reduce((v, si) => applySetChange(v, ei, si, { done: true }, { startRest: false, now: t0 }), value), w);
    const row = activityContent("w1", lifted, null, "kg", t0)?.state;
    const p = w.exercises[2]?.prescription;
    expect(row?.exercise).toBe(p?.name);
    expect(row?.detail).toMatch(/^Set 1 of \d · (\d+(\.\d+)? kg × )?\d+(–\d+)? reps( each side)?$/);
    expect(row?.completed).toBe(4);
    expect(activityContent("w1", { ...w, finishedAt: "2026-01-05T08:00:00.000Z" }, null, "kg", t0)).toBeNull();
  });

  test("counts a rest down to the next set, with an alert at its end", () => {
    const rested = applySetChange(workout(), 0, 0, { done: true }, { startRest: true, now: t0 });
    const content = activityContent("w1", rested, null, "kg", s(10));
    expect(content?.state).toMatchObject({
      phase: "rest",
      title: "Rest",
      exercise: "Next: Forearm plank",
      detail: "Set 2 of 2 · 30 s hold",
      doneTitle: "Rest done",
      doneDetail: "Next: Forearm plank · Set 2 of 2 · 30 s hold",
      timerStart: s(10),
      timerEnd: s(60),
    });
    expect(content?.staleAt).toBe(s(60));
    expect(content?.alert).toEqual({ at: s(60), title: "Rest done", body: "Next: Forearm plank, set 2." });
    // Once the rest ends, the activity shows the set again and the alert goes.
    expect(activityContent("w1", rested, null, "kg", s(60))?.state.phase).toBe("lift");
    // The same rest seen a moment later is the same activity.
    expect(sameActivity(content, activityContent("w1", rested, null, "kg", s(20)))).toBe(true);
    expect(sameActivity(content, activityContent("w1", { ...rested, restUntil: s(90) }, null, "kg", s(20)))).toBe(false);
  });

  test("shows each hold phase, with an alert when the whole hold ends", () => {
    const w = workout();
    const hold = startHold(w, 1, 0, { seconds: 20, right: 25 }, t0);
    if (!hold) throw new Error("No hold");
    const ready = activityContent("w1", w, hold, "kg", s(1));
    expect(ready?.state).toMatchObject({ phase: "ready", title: "Get ready", exercise: "Side plank", detail: "Set 1 of 2 · 20 s", timerEnd: s(5) });
    expect(ready?.alert).toEqual({ at: s(55), title: "Hold done", body: "Side plank, set 1. Open bent Fitness to record it." });
    expect(activityContent("w1", w, hold, "kg", s(6))?.state).toMatchObject({ phase: "hold", title: "Hold left", timerStart: s(5), timerEnd: s(25) });
    expect(activityContent("w1", w, hold, "kg", s(26))?.state).toMatchObject({ phase: "ready", title: "Switch to right", detail: "Set 1 of 2 · 25 s" });
    expect(activityContent("w1", w, hold, "kg", s(31))?.state).toMatchObject({ phase: "hold", title: "Hold right", timerEnd: s(55) });
    expect(activityContent("w1", w, hold, "kg", s(56))?.state.phase).toBe("lift");
  });
});
