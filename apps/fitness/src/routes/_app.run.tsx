import { createFileRoute } from "@tanstack/react-router";
import { RunScreen } from "../components/activity-pages";
export const Route = createFileRoute("/_app/run")({ component: Screen });
function Screen() {
  const { date } = Route.useSearch();
  return <RunScreen key={date} date={date ?? ""} />;
}
