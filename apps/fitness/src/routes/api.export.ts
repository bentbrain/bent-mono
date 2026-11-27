import { createFileRoute } from "@tanstack/react-router";
import { requireOwner } from "../server/auth";
import { exportResponse } from "../server/export";
export const Route = createFileRoute("/api/export")({
  server: {
    handlers: {
      GET: async () => {
        let owner: string;
        try {
          owner = await requireOwner();
        } catch {
          return new Response(
            "Sign in with an invited account to export your data.",
            { status: 403, headers: { "Cache-Control": "no-store" } },
          );
        }
        return exportResponse(owner);
      },
    },
  },
});
