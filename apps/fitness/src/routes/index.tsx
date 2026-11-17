import { createFileRoute } from "@tanstack/react-router";
import { AuthenticatedApp } from "../components/app";
export const Route = createFileRoute("/")({ component: AuthenticatedApp });
