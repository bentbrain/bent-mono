import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@bent/ui/button";
import {
  catalogueEntry,
  equipmentNames,
} from "@bent/fitness-contracts/catalogue";
import {
  displayLoad,
  formatDate,
  localDate,
  sessionMinutes,
} from "@bent/fitness-contracts/domain";
import type { Exercise, Settings } from "@bent/fitness-contracts/domain";
import type { StoredPlan } from "@bent/fitness-contracts/proposal";
import { decidePlanProposal, planProposal } from "../server/proposals";
import { useAccount } from "./account-context";
import { ExerciseThumb, prescriptionText } from "./exercises";
import { Icon } from "./icons";

type Review = Awaited<ReturnType<typeof planProposal>>;
const weekdays = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
const dayTypes = { strength: "Strength", run: "Run", rest: "Rest" } as const;

/** Loads the pending proposal; `null` until it has loaded. */
function usePendingProposal() {
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    planProposal()
      .then((value) => {
        if (active) setReview(value);
      })
      .catch(() => {
        if (active)
          setError("Plan proposals could not load. Reload to try again.");
      });
    return () => {
      active = false;
    };
  }, []);
  return { review, error };
}

const experienceNames = {
  new: "New to training",
  returning: "Returning to training",
  experienced: "Experienced",
} as const;

/**
 * The settings besides the week and routines that accepting `plan` changes,
 * as they read now and after, so the owner sees every change before
 * accepting it.
 */
function otherChanges(plan: StoredPlan, settings: Settings) {
  const units = settings.units;
  const weights = (values: number[] | undefined) =>
    values?.length
      ? values.map((kg) => `${displayLoad(kg, units)}`).join(", ") + ` ${units}`
      : "None";
  const profile = plan.profile ?? {};
  const changes: { label: string; from: string; to: string }[] = [];
  const add = (label: string, from: string, to: string) => {
    if (from !== to) changes.push({ label, from, to });
  };
  if (plan.goal !== undefined) add("Goal", settings.goal, plan.goal);
  if (plan.dumbbellsKg !== undefined)
    add("Dumbbells", weights(settings.dumbbellsKg), weights(plan.dumbbellsKg));
  if (profile.experience !== undefined)
    add(
      "Experience",
      settings.experience ? experienceNames[settings.experience] : "Not set",
      experienceNames[profile.experience],
    );
  if (profile.sessionMinutes !== undefined)
    add(
      "Session length",
      settings.sessionMinutes ? `${settings.sessionMinutes} min` : "Not set",
      `${profile.sessionMinutes} min`,
    );
  if (profile.limitations !== undefined)
    add(
      "Injuries and limits",
      settings.limitations || "None",
      profile.limitations || "None",
    );
  if (profile.availableEquipment !== undefined) {
    const names = (items: Settings["availableEquipment"]) =>
      items?.length
        ? items.map((item) => equipmentNames[item]).join(", ")
        : "None";
    add(
      "Equipment",
      settings.availableEquipment
        ? names(settings.availableEquipment)
        : "Not set",
      names(profile.availableEquipment),
    );
  }
  if (profile.kettlebellsKg !== undefined)
    add(
      "Kettlebells",
      weights(settings.kettlebellsKg),
      weights(profile.kettlebellsKg),
    );
  if (profile.incrementsKg !== undefined) {
    const steps = (value: Settings["incrementsKg"]) =>
      Object.entries(value ?? {})
        .map(([kind, kg]) => `${kind} ${displayLoad(kg, units)} ${units}`)
        .join(", ") || "Not set";
    add(
      "Weight steps",
      steps(settings.incrementsKg),
      steps(profile.incrementsKg),
    );
  }
  return changes;
}

/** Exercises as the plan records them, with names and modes from the catalogue. */
function routineExercises(routine: StoredPlan["routines"][number]) {
  return routine.exercises.flatMap((proposed): Exercise[] => {
    const entry = catalogueEntry(proposed.id);
    return entry
      ? [
          {
            id: entry.id,
            name: entry.name,
            mode: entry.mode,
            side: entry.side,
            sets: proposed.sets,
            min: proposed.min,
            max: proposed.max,
            rest: proposed.rest ?? entry.rest,
          },
        ]
      : [];
  });
}

/** A notice on the week screen while a proposal waits for review. */
export function ProposalNotice() {
  const { review } = usePendingProposal();
  if (!review?.proposal) return null;
  return (
    <div className="proposal-notice card">
      <p>
        <strong>Your assistant proposed a new training plan.</strong> Your plan
        stays the same until you accept it.
      </p>
      <Link className="bent-button bent-button--outline" to="/proposal">
        Review plan
      </Link>
    </div>
  );
}

export function ProposalScreen() {
  const { sync, today, settings } = useAccount();
  const navigate = useNavigate();
  const { review, error: loadError } = usePendingProposal();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function decide(id: string, decision: "accepted" | "dismissed") {
    setBusy(true);
    setError("");
    const message = await settle(id, decision);
    setBusy(false);
    if (message) setError(message);
    else await navigate({ to: "/" });
  }
  /** Records the decision and reloads the plan; returns a message on failure. */
  async function settle(id: string, decision: "accepted" | "dismissed") {
    try {
      const result = await decidePlanProposal({ data: { id, decision } });
      if (result.error) return result.error;
    } catch {
      return "Fitness couldn't confirm this change. Reload to see whether your plan changed.";
    }
    if (decision === "accepted" && !(await sync.retry()))
      return "Your new plan is saved. Reload to see it.";
    return "";
  }
  const head = (
    <Link className="back-link" to="/">
      <Icon name="back" size={16} /> Back to week
    </Link>
  );
  if (loadError)
    return (
      <section className="proposal-screen">
        {head}
        <p role="alert">{loadError}</p>
      </section>
    );
  if (!review) return <section className="proposal-screen">{head}</section>;
  const { proposal, check } = review;
  if (!proposal)
    return (
      <section className="proposal-screen">
        {head}
        <header className="page-head">
          <h1>Plan proposal</h1>
        </header>
        <p className="empty">
          No plan is waiting for review. Ask your assistant to propose one.
        </p>
      </section>
    );
  const { plan } = proposal;
  const blocked = !check?.ok;
  const unsaved = sync.pending > 0;
  const changes = otherChanges(plan, settings);
  return (
    <section
      className="proposal-screen"
      data-feedback-private
      data-feedback-redact
    >
      {head}
      <header className="page-head">
        <p className="eyebrow">
          Plan proposal ·{" "}
          {formatDate(
            localDate(settings.timezone, new Date(proposal.createdAt)),
          )}
        </p>
        <h1>New training plan</h1>
        {plan.goal && <p className="subtitle">{plan.goal}</p>}
      </header>
      <div className="plan-summary input-notice">
        <p>{plan.summary}</p>
      </div>
      <h2 className="section-label">Your week</h2>
      <ul className="proposal-week">
        {plan.schedule.map((type, index) => (
          <li key={weekdays[index]}>
            <span>{weekdays[index]}</span>
            <strong>{dayTypes[type]}</strong>
          </li>
        ))}
      </ul>
      {plan.routines.map((routine) => {
        const exercises = routineExercises(routine);
        return (
          <section className="proposal-routine" key={routine.id}>
            <h2 className="section-label">{routine.name}</h2>
            <p className="subtitle">
              About{" "}
              {sessionMinutes(
                { id: routine.id, name: routine.name, exercises },
                false,
              )}{" "}
              min · {exercises.length} exercises
            </p>
            <div className="plan-list">
              {exercises.map((exercise, index) => (
                <article
                  className="proposal-exercise"
                  key={`${exercise.id}:${index}`}
                >
                  <ExerciseThumb id={exercise.id} />
                  <div>
                    <h3>{exercise.name}</h3>
                    <p className="prescription">{prescriptionText(exercise)}</p>
                  </div>
                </article>
              ))}
            </div>
          </section>
        );
      })}
      {changes.length > 0 && (
        <div className="proposal-changes card">
          <h2>Also changes</h2>
          <dl>
            {changes.map((change) => (
              <div key={change.label}>
                <dt>{change.label}</dt>
                <dd>
                  {change.to}
                  <span>Now: {change.from}</span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {check && check.warnings.length > 0 && (
        <div className="proposal-warnings card">
          <h2>Worth checking</h2>
          <ul>
            {check.warnings.map((warning) => (
              <li key={`${warning.path}:${warning.message}`}>
                {warning.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {check && !check.ok && (
        <div className="error" role="alert">
          <p>
            This plan no longer fits your account. Ask your assistant for a new
            one.
          </p>
          <ul>
            {check.errors.map((problem) => (
              <li key={`${problem.path}:${problem.message}`}>
                {problem.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="finish-bar">
        <p>
          Accepting replaces your routines, your repeating week and the sessions
          planned from {formatDate(today)} on. Workouts you recorded keep their
          results.
        </p>
        {unsaved && <p>Finish saving your changes before accepting.</p>}
        <div className="proposal-actions">
          <Button
            appearance="primary"
            disabled={busy || blocked || unsaved}
            onClick={() => void decide(proposal.id, "accepted")}
          >
            Accept plan
          </Button>
          <Button
            appearance="outline"
            disabled={busy}
            onClick={() => void decide(proposal.id, "dismissed")}
          >
            Dismiss
          </Button>
        </div>
        {error && <p role="alert">{error}</p>}
      </div>
    </section>
  );
}
