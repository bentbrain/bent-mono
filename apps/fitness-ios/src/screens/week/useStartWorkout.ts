import { useRef, useState } from "react";
import { Alert } from "react-native";
import { createWorkout, scheduled } from "@bent/fitness-contracts/domain";
import type { Routine } from "@bent/fitness-contracts/domain";
import { useConfiguredAccount } from "../../account/AccountProvider";
import { haptic } from "../../ui/haptics";
import { activeWorkout } from "./logic";
import { useWeekNavigation } from "./navigation";

/** Starts a routine as a recoverable workout record and opens it. */
export function useStartWorkout() {
  const { sync, settings } = useConfiguredAccount();
  const navigation = useWeekNavigation();
  const [starting, setStarting] = useState(false);
  // Guards a second tap before React renders the first one.
  const busy = useRef(false);
  const active = activeWorkout(sync.records);
  function start(routine: Routine, day: string) {
    if (busy.current || active) return;
    busy.current = true;
    setStarting(true);
    const id = crypto.randomUUID();
    try {
      const queued = sync.put(createWorkout(settings, routine, day, scheduled(settings, day).intro, sync.records), id);
      if (queued) {
        haptic("success");
        navigation.navigate("Workout", { workoutId: id });
      } else {
        haptic("error");
        Alert.alert("The workout didn't start", sync.error || "Resolve the sync message and try again.");
      }
    } catch (problem) {
      haptic("error");
      Alert.alert("The workout didn't start", problem instanceof Error ? problem.message : "Check your plan and try again.");
    } finally {
      // The Week screen stays mounted under the workout, so it is ready again on return.
      busy.current = false;
      setStarting(false);
    }
  }
  return { start, starting, active };
}
