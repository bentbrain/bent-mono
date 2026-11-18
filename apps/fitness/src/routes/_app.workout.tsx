import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { WorkoutScreen } from "../components/activity-pages";
export const Route = createFileRoute("/_app/workout")({
  head: () => ({ meta: [{ title: "Workout · Fitness · bent.build" }] }),
  validateSearch: (search: Record<string, unknown>) => ({
    workoutId: z.string().uuid().catch("").parse(search.workoutId),
  }),
  component: Screen,
});
function Screen() {
  const { workoutId } = Route.useSearch();
  return <WorkoutScreen key={workoutId} workoutId={workoutId} />;
}
