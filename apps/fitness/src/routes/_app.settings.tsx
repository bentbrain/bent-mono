import { createFileRoute } from "@tanstack/react-router";
import { SettingsScreen } from "../components/app";
export const Route = createFileRoute("/_app/settings")({
  head: () => ({ meta: [{ title: "Settings · Fitness · bent.build" }] }),
  component: SettingsScreen,
});
