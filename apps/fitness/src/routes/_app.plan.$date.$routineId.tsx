import { createFileRoute } from "@tanstack/react-router";
import { PlanScreen } from "../components/activity-pages";
export const Route = createFileRoute("/_app/plan/$date/$routineId")({
  component: Screen,
});
function Screen() {
  const { date, routineId } = Route.useParams();
  return <PlanScreen date={date} routineId={routineId} />;
}
