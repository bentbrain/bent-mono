"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { getDraftForEditor } from "@/client/draft-handoff";
import { getBaseProductAvailability } from "@/client/product-availability";
import { designQueryKey } from "@/client/query-keys";
import { CameraPreparingPage } from "@/components/camera-preparing";
import { ShirtEditor } from "@/components/shirt-editor";
import { MobileOnlyGate } from "@/components/mobile-only-gate";
import { Button } from "@/components/ui/button";

export function DesignEditorMobileContent({
  cameraLaunch,
  uploadLaunch = false,
  id,
}: {
  cameraLaunch: boolean;
  uploadLaunch?: boolean;
  id: string;
}) {
  const router = useRouter();
  const [continuingDesignId, setContinuingDesignId] = useState<string>();
  const continuingToProduct = continuingDesignId === id;
  const designQuery = useQuery({
    queryKey: designQueryKey(id),
    enabled: !continuingToProduct,
    queryFn: () => getDraftForEditor(id),
    refetchOnMount: "always",
    refetchInterval: (query) => ["pending", "processing"].includes(query.state.data?.artworkProcessingStatus ?? "") || query.state.data?.defaultColorStatus === "pending" ||
      (query.state.data?.status === "ready" && query.state.data.maximumCropZoom === null)
      ? 1_000
      : false,
  });
  const productAvailabilityQuery = useQuery({
    queryKey: ["base-product-availability"],
    queryFn: getBaseProductAvailability,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!continuingToProduct && designQuery.data?.finalized) router.replace("/create");
  }, [continuingToProduct, designQuery.data?.finalized, router]);

  if (!continuingToProduct && designQuery.data?.finalized) return <DesignEditorLoading />;

  if (designQuery.isPending || !designQuery.isFetchedAfterMount) {
    return cameraLaunch || uploadLaunch
      ? <CameraPreparingPage label={uploadLaunch ? "Preparing image" : "Preparing camera"} />
      : <DesignEditorLoading />;
  }
  if (designQuery.isError && designQuery.data === undefined) {
    return (
      <main className="grid flex-1 place-items-center bg-background px-5 text-center text-primary">
        <div className="max-w-sm">
          <p className="text-xs font-bold tracking-[0.08em]">
            Design unavailable
          </p>
          <h1 className="mt-3 text-4xl leading-tight font-bold tracking-[-0.04em]">
            We couldn&apos;t open this draft.
          </h1>
          <p className="mt-4 text-sm leading-6">
            Check the link and your connection, then try again.
          </p>
          <Button
            type="button"
            className="mt-8 min-h-12 rounded-none border border-primary bg-primary px-5 font-mono text-xs font-bold tracking-[0.06em] text-primary-foreground uppercase hover:bg-background hover:text-primary"
            onClick={() => void designQuery.refetch()}
          >
            Try again
          </Button>
        </div>
      </main>
    );
  }

  const design = designQuery.data;
  return (
    <MobileOnlyGate draftHandoff renderMobileFallback>
      <ShirtEditor
        onContinuationChange={pending => { setContinuingDesignId(pending ? id : undefined); }}
        uploadLaunch={uploadLaunch}
        defaultColor={design.defaultColor ?? "White"}
        baseProductAvailability={
          productAvailabilityQuery.data?.available === true
            ? "available"
            : productAvailabilityQuery.isPending ||
                productAvailabilityQuery.isFetching
              ? "checking"
              : "unavailable"
        }
        onRetryProductAvailability={() => {
          void productAvailabilityQuery.refetch();
        }}
        initialDesign={{
          artworkRevision: design.artworkRevision,
          previewReady: design.previewReady,
          artworkJobId: design.artworkJobId,
          artworkProcessingStatus: design.artworkProcessingStatus,
          maximumCropZoom: design.maximumCropZoom,
          hasOriginalArtwork: design.hasOriginalArtwork,
          id: design.id,
          status: design.status,
          settings: design.settings,
          updatedAt: design.updatedAt,
        }}
      />
    </MobileOnlyGate>
  );
}

function DesignEditorLoading() {
  return (
    <main
      className="grid flex-1 place-items-center bg-background text-primary"
      role="status"
      aria-label="Loading design"
    >
      <span className="font-mono text-xs tracking-[0.08em]">
        Loading design…
      </span>
    </main>
  );
}
