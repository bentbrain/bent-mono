import { createFileRoute } from "@tanstack/react-router";
import { handlePhotoList, handlePhotoUpload } from "../server/app-api";
export const Route = createFileRoute("/api/app/photos")({
  server: {
    handlers: {
      GET: ({ request }) => handlePhotoList(request),
      POST: ({ request }) => handlePhotoUpload(request),
    },
  },
});
