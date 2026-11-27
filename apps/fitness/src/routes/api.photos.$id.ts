import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireOwner } from "../server/auth";
import { photoResponse } from "../server/photo-store";
export const Route = createFileRoute("/api/photos/$id")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        try {
          const owner = await requireOwner();
          return await photoResponse(owner, z.uuid().parse(params.id));
        } catch {
          return new Response(
            "Sign in with an invited account to view this photo.",
            { status: 403, headers: { "Cache-Control": "no-store" } },
          );
        }
      },
    },
  },
});
