import { createFileRoute } from "@tanstack/react-router";
import { SettingsScreen } from "../components/app";
export const Route = createFileRoute("/_app/settings")({
  component: SettingsScreen,
});
