import { createFileRoute } from "@tanstack/react-router";
import { handlePhotoDelete, handlePhotoRead } from "../server/app-api";
export const Route = createFileRoute("/api/app/photos/$id")({
  server: {
    handlers: {
      GET: ({ request, params }) => handlePhotoRead(request, params.id),
      DELETE: ({ request, params }) => handlePhotoDelete(request, params.id),
    },
  },
});
