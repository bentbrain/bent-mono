import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@bent/ui/sdk/button";
import { catalogueEntry } from "@bent/fitness-contracts/catalogue";
import {
  formatDate,
  localDate,
  sessionMinutes,
} from "@bent/fitness-contracts/domain";
import type { Exercise } from "@bent/fitness-contracts/domain";
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
  const [loads, setLoads] = useState(0);
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
  }, [loads]);
  return { review, error, reload: () => setLoads((count) => count + 1) };
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
      <Button appearance="outline" render={<Link to="/proposal" />}>
        Review plan
      </Button>
    </div>
  );
}

export function ProposalScreen() {
  const { sync, today, settings } = useAccount();
  const navigate = useNavigate();
  const { review, error: loadError, reload } = usePendingProposal();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** Set once Fitness confirmed the decision but the new plan didn't load. */
  const [decided, setDecided] = useState(false);
  async function decide(
    request: Parameters<typeof decidePlanProposal>[0]["data"],
  ) {
    setBusy(true);
    setError("");
    try {
      const outcome = await settle(request);
      if (outcome === "done") await navigate({ to: "/" });
    } finally {
      setBusy(false);
    }
  }
  /** Records the decision and loads the new plan. */
  async function settle(
    request: Parameters<typeof decidePlanProposal>[0]["data"],
  ) {
    try {
      const result = await decidePlanProposal({ data: request });
      if (result.error) {
        setError(result.error);
        // The settings changed since the review loaded: show it afresh.
        if (result.stale) reload();
        return "failed";
      }
    } catch {
      setError(
        "Fitness couldn't confirm this change. Reload to see whether your plan changed.",
      );
      return "failed";
    }
    if (request.decision === "accepted" && !(await sync.retry())) {
      setDecided(true);
      setError("Your new plan is saved. Reload to see it.");
      return "failed";
    }
    return "done";
  }
  const head = (
    <Button className="back-link" render={<Link to="/" />}>
      <Icon name="back" size={16} /> Back to week
    </Button>
  );
  if (loadError)
    return (
      <section className="proposal-screen">
        {head}
        <p role="alert">{loadError}</p>
      </section>
    );
  if (!review) return <section className="proposal-screen">{head}</section>;
  const { proposal, review: check } = review;
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
  const changes = check?.changes ?? [];
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
          {decided ? (
            <Button
              appearance="primary"
              onClick={() => window.location.reload()}
            >
              Reload
            </Button>
          ) : (
            <>
              <Button
                appearance="primary"
                disabled={busy || blocked || unsaved || !check}
                data-agent-confirm="Replaces your routines, repeating week and planned sessions with this proposed plan"
                onClick={() =>
                  check &&
                  void decide({
                    id: proposal.id,
                    decision: "accepted",
                    reviewedRevision: check.revision,
                  })
                }
              >
                Accept plan
              </Button>
              <Button
                appearance="outline"
                disabled={busy}
                data-agent-confirm="Dismisses this proposed plan"
                onClick={() =>
                  void decide({ id: proposal.id, decision: "dismissed" })
                }
              >
                Dismiss
              </Button>
            </>
          )}
        </div>
        {error && <p role="alert">{error}</p>}
      </div>
    </section>
  );
}
