import { createFileRoute } from "@tanstack/react-router";
import { ScheduleScreen } from "../components/app";
export const Route = createFileRoute("/_app/schedule")({
  head: () => ({ meta: [{ title: "Repeating week · Fitness · bent.build" }] }),
  component: ScheduleScreen,
});
