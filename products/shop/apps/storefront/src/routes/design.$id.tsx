import { createFileRoute } from "@tanstack/react-router";
import { launchSearch } from "../lib/launch-search";
import { DesignEditorMobileContent } from "@/components/design-editor-mobile-content";
export const Route = createFileRoute("/design/$id")({
  validateSearch: launchSearch,
  component: Design,
});
function Design() {
  const { id } = Route.useParams();
  const { upload, camera } = Route.useSearch();
  return (
    <DesignEditorMobileContent
      id={id}
      cameraLaunch={camera}
      uploadLaunch={upload}
    />
  );
}
