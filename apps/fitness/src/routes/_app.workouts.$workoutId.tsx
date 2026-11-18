import { createFileRoute } from "@tanstack/react-router";
import { WorkoutScreen } from "../components/activity-pages";
export const Route = createFileRoute("/_app/workouts/$workoutId")({
  component: Screen,
});
function Screen() {
  const { workoutId } = Route.useParams();
  return <WorkoutScreen workoutId={workoutId} />;
}
