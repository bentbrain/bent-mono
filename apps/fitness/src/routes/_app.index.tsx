import { createFileRoute } from "@tanstack/react-router";
import { WeekScreen } from "../components/week";
export const Route = createFileRoute("/_app/")({
  head: () => ({ meta: [{ title: "Week · Fitness · bent.build" }] }),
  component: WeekScreen,
});
