import { pageRoute, rootRoute } from "../../navigation/options";
import { PlanSettingsScreen } from "../settings/PlanSettingsScreen";
import { PlanScreen } from "./PlanScreen";
import { RunScreen } from "./RunScreen";
import { WeekScreen } from "./WeekScreen";
import { WorkoutScreen } from "./workout/WorkoutScreen";

/** The Week tab: the planner, a day's plan, workouts, runs and the repeating week. */
export const weekScreens = {
  Week: { screen: WeekScreen, options: rootRoute("Week") },
  Plan: { screen: PlanScreen, options: pageRoute("Workout plan") },
  Workout: { screen: WorkoutScreen, options: pageRoute("Workout") },
  Run: { screen: RunScreen, options: pageRoute("Run") },
  Schedule: { screen: PlanSettingsScreen, options: pageRoute("Repeating week") },
};
