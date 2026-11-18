import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { AuthenticatedApp } from "../components/app";
export const Route = createFileRoute("/_app")({
  validateSearch: (search: Record<string, unknown>): { date?: string } => {
    const date = z.iso.date().safeParse(search.date);
    return { date: date.success ? date.data : undefined };
  },
  component: AuthenticatedApp,
});
