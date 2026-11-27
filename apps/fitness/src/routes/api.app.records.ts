import { createFileRoute } from "@tanstack/react-router";
import { handleRecordSave, handleRecordsLoad } from "../server/app-api";
export const Route = createFileRoute("/api/app/records")({
  server: {
    handlers: {
      GET: ({ request }) => handleRecordsLoad(request),
      POST: ({ request }) => handleRecordSave(request),
    },
  },
});
