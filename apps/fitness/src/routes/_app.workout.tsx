import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { WorkoutScreen } from "../components/activity-pages";
export const Route = createFileRoute("/_app/workout")({
  validateSearch: (search: Record<string, unknown>) => ({
    workoutId: z.string().uuid().catch("").parse(search.workoutId),
  }),
  component: Screen,
});
function Screen() {
  const { workoutId } = Route.useSearch();
  return <WorkoutScreen key={workoutId} workoutId={workoutId} />;
}
