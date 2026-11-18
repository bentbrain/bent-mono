import { createFileRoute } from "@tanstack/react-router";
import { RunScreen } from "../components/activity-pages";
export const Route = createFileRoute("/_app/runs/$date")({ component: Screen });
function Screen() {
  const { date } = Route.useParams();
  return <RunScreen key={date} date={date} />;
}
