import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { createWorkout, scheduled } from "@bent/fitness-contracts/domain";
import type { Routine } from "@bent/fitness-contracts/domain";
import { useAccount } from "./account-context";

/** Starts a routine as a recoverable workout draft and opens it. */
export function useStartWorkout() {
  const { sync, settings } = useAccount();
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);
  const active = sync.records.find(
    (record) => record.data.kind === "workout" && !record.data.finishedAt,
  );
  function start(routine: Routine, day: string) {
    if (starting || active) return;
    setStarting(true);
    const id = crypto.randomUUID();
    if (
      sync.put(
        createWorkout(
          settings,
          routine,
          day,
          scheduled(settings, day).intro,
          sync.records,
        ),
        id,
      )
    )
      void navigate({ to: "/workout", search: { workoutId: id } });
    else setStarting(false);
  }
  return { start, starting, active };
}
