import { createFileRoute } from "@tanstack/react-router";
import { GuidesScreen } from "../components/app";
export const Route = createFileRoute("/_app/guides")({
  head: () => ({ meta: [{ title: "Exercise guides · Fitness · bent.build" }] }),
  component: GuidesScreen,
});
