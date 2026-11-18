import { createFileRoute } from "@tanstack/react-router";
import { TodayScreen } from "../components/app";
export const Route = createFileRoute("/_app/")({
  head: () => ({ meta: [{ title: "Today · Fitness · bent.build" }] }),
  component: TodayScreen,
});
