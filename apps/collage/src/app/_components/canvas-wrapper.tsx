"use client";
import { type Background, type Category } from "@/payload-types";
import { api } from "@/trpc/react";
import { type Collage, type SerializedCanvas } from "@/types/canvas";
import { FabricImage, type Canvas } from "fabric";
import {
  CopyPlus,
  Download,
  FlipHorizontal2,
  FlipVertical2,
  Image as ImageIcon,
  Info,
  Loader2,
  Redo2,
  Settings,
  Trash2,
  Undo2,
} from "lucide-react";
import dynamic from "next/dynamic";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as R from "remeda";
import CanvasComponent, {
  handleDelete,
  handleDownloadCanvas,
  handleDuplicate,
  handleFlipX,
  handleFlipY,
  serializeCanvasObjects,
  updateCanvasBackground,
} from "./canvas";
import { GradientPicker, type BackgroundValue } from "./gradient-picker";
import JoyrideWrapper from "./JoyrideWrapper";
import PublicButton from "./public-button";
import SaveButton from "./save-button";
import { Button } from "./ui/button";
import { Card, CardHeader } from "./ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { useSidebar } from "./ui/sidebar";
import { useCanvasHistory } from "./use-canvas-history";
import type { ImageSaveResult } from "./download-utils";

const EMPTY_BACKGROUNDS: Background = { id: 0, backgrounds: [] };
const CanvasGalleries = dynamic(() => import("./canvas-galleries"), {
  loading: () => <StickerPanelSkeleton />,
  ssr: false,
});

type Props = {
  userId: string;
  collage?: Collage;
  showTutorial?: boolean;
};

function CanvasWrapper({ userId, collage, showTutorial }: Props) {
  const {
    data: builderAssets,
    error: builderAssetsError,
    isPending: builderAssetsPending,
    refetch: refetchBuilderAssets,
  } = api.collage.getBuilderAssets.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const categories = builderAssets?.categories ?? [];
  const backgrounds = builderAssets?.backgrounds ?? EMPTY_BACKGROUNDS;
  const fabricCanvasRef = useRef<Canvas | null>(null);
  const [startTutorial, setStartTutorial] = useState<{
    running: boolean;
    stepIndex: number | undefined;
  }>({
    running: showTutorial ?? false,
    stepIndex: undefined,
  });

  // Add state to track if any object is selected
  const [isObjectSelected, setIsObjectSelected] = useState(false);

  const collageJson = collage?.collageJson as SerializedCanvas | undefined;
  const initialBackground =
    collageJson?.backgroundImage ?? collageJson?.background ?? "#ffffff";
  const {
    objects,
    backgroundColor,
    recordObjects,
    recordBackground,
    undo,
    redo,
    canUndo,
    canRedo,
    isRestoring,
  } = useCanvasHistory({
    fabricCanvasRef,
    initialObjects: collageJson?.objects ?? [],
    initialBackground,
  });
  const [hasChanges, setHasChanges] = useState(false);

  // Force a re-render when navigating to ensure proper initialization
  useEffect(() => {
    // Reset the canvas reference when navigating to ensure proper initialization
    if (fabricCanvasRef.current) {
      // Only update the background, don't reset the entire canvas
      updateCanvasBackground({
        fabricCanvasRef,
        storeBackgroundColor: backgroundColor,
      });

      // Force a resize after navigation
      const canvas = fabricCanvasRef.current;

      // Get the container element that holds the canvas
      const canvasContainer = document.querySelector(
        ".canvas-container-parent",
      );
      const containerWidth =
        canvasContainer?.clientWidth ?? Math.min(800, window.innerWidth);
      const containerHeight =
        canvasContainer?.clientHeight ?? window.innerHeight;

      // For a square canvas, use the smaller dimension to ensure it fits
      const availableSpace = Math.min(containerWidth, containerHeight);

      // Maintain aspect ratio (canvas is always square in this case)
      const ratio = 1; // width/height ratio (1 for square)

      // Calculate the appropriate size based on available space
      const targetSize = Math.min(800, availableSpace);
      const targetWidth = targetSize;
      const targetHeight = targetSize / ratio;

      // Calculate the scale factor
      const originalWidth = 800; // The design width
      const scale = targetWidth / originalWidth;

      // Update canvas dimensions
      canvas.setDimensions({ width: targetWidth, height: targetHeight });

      // Scale the canvas content accordingly
      canvas.setViewportTransform([scale, 0, 0, scale, 0, 0]);

      // Force a re-render of the canvas
      canvas.requestRenderAll();
    }
  }, [backgroundColor]);

  // Memoize canvas JSON to maintain a stable referential identity.
  const memoizedCanvasJson = useMemo(
    () => (objects.length > 0 ? { objects } : undefined),
    [objects],
  );

  const { isMobile } = useSidebar();

  // Use refs to store previous values (helps reduce heavy computations).
  const prevObjectsRef = useRef(objects);
  const prevBackgroundRef = useRef(backgroundColor);

  // Add a ref to determine if the component has mounted.
  const didMountRef = useRef(false);

  // Debounce the deep equality check so that we avoid running expensive comparisons during rapid changes.
  useEffect(() => {
    const handler = window.setTimeout(() => {
      // Skip the first run so that a saved canvas doesn't get marked as unsaved immediately.
      if (!didMountRef.current) {
        didMountRef.current = true;
        return;
      }

      const objectsChanged = !R.isDeepEqual(prevObjectsRef.current, objects);
      const backgroundChanged = !R.isDeepEqual(
        prevBackgroundRef.current,
        backgroundColor,
      );

      if (objectsChanged || backgroundChanged) {
        setHasChanges(true);
        prevObjectsRef.current = objects;
        prevBackgroundRef.current = backgroundColor;
      }
    }, 100);

    return () => window.clearTimeout(handler);
  }, [
    objects,
    backgroundColor,
    collageJson?.background,
    collageJson?.backgroundImage,
  ]);

  // Stable callback for background change.
  const handleBackgroundChange = useCallback(
    (newBackground: BackgroundValue) => {
      recordBackground(newBackground);
    },
    [recordBackground],
  );

  // Stable function to clear the canvas and update the background.
  const clearCanvas = useCallback(() => {
    fabricCanvasRef.current?.clear();
    updateCanvasBackground({
      fabricCanvasRef,
      storeBackgroundColor: backgroundColor,
    });
    recordObjects([]);
    setIsObjectSelected(false);
  }, [backgroundColor, recordObjects]);

  const handleUndo = useCallback(() => {
    setIsObjectSelected(false);
    void undo();
  }, [undo]);

  const handleRedo = useCallback(() => {
    setIsObjectSelected(false);
    void redo();
  }, [redo]);

  // Stable callback to trigger canvas download.
  const downloadCanvas = useCallback(
    () => handleDownloadCanvas(fabricCanvasRef),
    [],
  );

  const handleImageClick = (imageData: {
    url: string;
    alt?: string;
    isNsfw?: boolean;
  }) => {
    if (!fabricCanvasRef.current) return;
    const canvas = fabricCanvasRef.current;
    // Use FabricImage.fromURL to add image to the canvas at a default position.
    FabricImage.fromURL(imageData.url, { crossOrigin: "anonymous" })
      .then((img) => {
        const maxWidth = 300;
        const maxHeight = 300;
        const scale = Math.min(maxWidth / img.width, maxHeight / img.height, 1);
        img.set({
          originX: "center",
          originY: "center",
          left: canvas.getWidth() / 2,
          top: canvas.getHeight() / 2,
          cornerStyle: "circle",
          transparentCorners: false,
          scaleX: scale,
          scaleY: scale,
          src: imageData.url,
          alt: imageData.alt,
          isNsfw: imageData.isNsfw,
        });
        canvas.add(img);
        canvas.setActiveObject(img);
        canvas.requestRenderAll();
        recordObjects(serializeCanvasObjects(canvas));
      })
      .catch((error) => {
        console.error("Failed to add image to the canvas:", error);
      });
  };

  // Add a callback to handle selection changes
  const handleSelectionChange = useCallback((selected: boolean) => {
    setIsObjectSelected(selected);
  }, []);

  return (
    <>
      {!builderAssetsPending &&
      !builderAssetsError &&
      (showTutorial || startTutorial.running) ? (
        <JoyrideWrapper
          userId={userId}
          startTutorial={startTutorial}
          setStartTutorial={setStartTutorial}
        />
      ) : null}
      <Card className="w-full sm:w-auto">
        <CardHeader className="flex flex-row items-center justify-end gap-2 space-y-0 border-b-4 border-stone-900 p-2">
          <div
            className="mr-auto flex gap-2"
            role="toolbar"
            aria-label="Selected image tools"
          >
            {!isMobile && (
              <Button
                variant={"outline"}
                size={"icon"}
                className="m-0 text-sm"
                aria-label="Open collage tutorial"
                title="Tutorial"
                onClick={() =>
                  setStartTutorial({
                    running: true,
                    stepIndex: 0,
                  })
                }
              >
                <Info className="h-4 w-4" />
              </Button>
            )}
            <Button
              variant={"outline"}
              size={"icon"}
              aria-label="Undo last canvas edit"
              title="Undo (⌘Z)"
              onClick={handleUndo}
              disabled={!canUndo || isRestoring}
            >
              <Undo2 />
            </Button>
            <Button
              variant={"outline"}
              size={"icon"}
              aria-label="Redo last canvas edit"
              title="Redo (⌘⇧Z)"
              onClick={handleRedo}
              disabled={!canRedo || isRestoring}
            >
              <Redo2 />
            </Button>
            {!isMobile && (
              <Button
                variant={"outline"}
                size={"icon"}
                aria-label="Duplicate selected image"
                title="Duplicate (⌘D)"
                onClick={() =>
                  void (
                    fabricCanvasRef.current &&
                    handleDuplicate(fabricCanvasRef.current, recordObjects)
                  )
                }
                disabled={!isObjectSelected || isRestoring}
              >
                <CopyPlus />
              </Button>
            )}
            <Button
              variant={"outline"}
              size={"icon"}
              aria-label="Delete selected image"
              title="Delete selected image"
              onClick={() =>
                handleDelete(fabricCanvasRef.current, recordObjects)
              }
              disabled={!isObjectSelected}
            >
              <Trash2 />
            </Button>
            <Button
              variant={"outline"}
              size={"icon"}
              aria-label="Flip selected image horizontally"
              title="Flip horizontally"
              onClick={() =>
                handleFlipX(fabricCanvasRef.current, recordObjects)
              }
              disabled={!isObjectSelected}
            >
              <FlipHorizontal2 />
            </Button>
            <Button
              variant={"outline"}
              size={"icon"}
              aria-label="Flip selected image vertically"
              title="Flip vertically"
              onClick={() =>
                handleFlipY(fabricCanvasRef.current, recordObjects)
              }
              disabled={!isObjectSelected}
            >
              <FlipVertical2 />
            </Button>
          </div>
          {isMobile && (
            <>
              <CanvasStickers
                isMobile={isMobile}
                onImageClick={handleImageClick}
                categories={categories}
                isLoading={builderAssetsPending}
                hasError={Boolean(builderAssetsError)}
                onRetry={() => void refetchBuilderAssets()}
              />
            </>
          )}
          <CanvasSettings
            collage={collage}
            backgroundColor={backgroundColor}
            handleBackgroundChange={handleBackgroundChange}
            fabricCanvasRef={fabricCanvasRef}
            backgrounds={backgrounds}
            clearCanvas={clearCanvas}
            downloadCanvas={downloadCanvas}
            userId={userId}
            setHasChanges={setHasChanges}
            hasChanges={hasChanges}
            isMobile={isMobile}
          />
        </CardHeader>
        <div
          className={`flex aspect-square h-auto w-full flex-col sm:aspect-auto sm:flex-row md:h-[500px] 2xl:h-[800px]`}
        >
          {!isMobile && (
            <div className="flex h-full flex-col overflow-hidden border-r-4 border-black">
              <CanvasStickers
                isMobile={isMobile}
                onImageClick={handleImageClick}
                categories={categories}
                isLoading={builderAssetsPending}
                hasError={Boolean(builderAssetsError)}
                onRetry={() => void refetchBuilderAssets()}
              />
            </div>
          )}
          <div
            className="canvas-container-parent flex aspect-square w-full flex-1 items-center justify-center"
            style={{
              width: "100%",
              height: "100%",
              maxWidth: isMobile ? "100%" : "800px",
              maxHeight: isMobile ? "100%" : "800px",
              margin: "0 auto",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <CanvasComponent
              fabricCanvasRef={fabricCanvasRef}
              backgroundColor={backgroundColor}
              canvasJson={memoizedCanvasJson}
              setObjects={recordObjects}
              hasSelection={isObjectSelected}
              onUndo={handleUndo}
              onRedo={handleRedo}
              className="h-full w-full"
              onSelectionChange={handleSelectionChange}
            />
          </div>
        </div>
      </Card>
    </>
  );
}

export default React.memo(CanvasWrapper);

type CanvasSettingsProps = {
  collage?: Collage;
  backgroundColor: BackgroundValue;
  handleBackgroundChange: (newBackground: BackgroundValue) => void;
  fabricCanvasRef: React.RefObject<Canvas | null>;
  backgrounds: Background;
  clearCanvas: () => void;
  downloadCanvas: () => Promise<ImageSaveResult>;
  userId: string;
  setHasChanges: React.Dispatch<React.SetStateAction<boolean>>;
  hasChanges: boolean;
  isMobile: boolean;
};

const CanvasSettings = ({
  collage,
  backgroundColor,
  handleBackgroundChange,
  fabricCanvasRef,
  backgrounds,
  clearCanvas,
  setHasChanges,
  hasChanges,
  downloadCanvas,
  userId,
  isMobile,
}: CanvasSettingsProps) => {
  return isMobile ? (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant={"outline"} className="m-0 text-sm">
          <Settings className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent>
        <div className="grid gap-2">
          <CanvasButtons
            collage={collage}
            backgroundColor={backgroundColor}
            handleBackgroundChange={handleBackgroundChange}
            fabricCanvasRef={fabricCanvasRef}
            backgrounds={backgrounds}
            clearCanvas={clearCanvas}
            downloadCanvas={downloadCanvas}
            userId={userId}
            setHasChanges={setHasChanges}
            hasChanges={hasChanges}
          />
        </div>
      </PopoverContent>
    </Popover>
  ) : (
    <CanvasButtons
      collage={collage}
      backgroundColor={backgroundColor}
      handleBackgroundChange={handleBackgroundChange}
      fabricCanvasRef={fabricCanvasRef}
      backgrounds={backgrounds}
      clearCanvas={clearCanvas}
      downloadCanvas={downloadCanvas}
      userId={userId}
      setHasChanges={setHasChanges}
      hasChanges={hasChanges}
    />
  );
};

const CanvasButtons = ({
  collage,
  backgroundColor,
  handleBackgroundChange,
  fabricCanvasRef,
  backgrounds,
  clearCanvas,
  setHasChanges,
  hasChanges,
  downloadCanvas,
  userId,
}: Omit<CanvasSettingsProps, "isMobile">) => {
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadMessage, setDownloadMessage] = useState<string>();
  const [downloadError, setDownloadError] = useState<string>();

  const handleDownload = async () => {
    setIsDownloading(true);
    setDownloadMessage(undefined);
    setDownloadError(undefined);

    try {
      const result = await downloadCanvas();
      setDownloadMessage(
        result === "shared"
          ? "Collage shared."
          : result === "downloaded"
            ? "Download started."
            : "Download cancelled.",
      );
    } catch (error) {
      console.error("Failed to download collage:", error);
      setDownloadError(
        "The collage could not be downloaded. Please try again.",
      );
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <>
      {collage && (
        <PublicButton
          isPublic={collage.public}
          canvasId={collage.id}
          userId={userId}
        />
      )}
      <GradientPicker
        background={backgroundColor}
        setBackground={handleBackgroundChange}
        backgrounds={backgrounds}
      />
      <SaveButton
        userId={userId}
        fabricCanvasRef={fabricCanvasRef}
        canvasId={collage?.id}
        hasChanges={hasChanges}
        setHasChanges={setHasChanges}
      />
      <Button
        variant={"outline"}
        className="m-0 text-sm"
        onClick={handleDownload}
        disabled={isDownloading}
      >
        Download
        {isDownloading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Download className="h-4 w-4" />
        )}
      </Button>
      {downloadMessage && (
        <p className="sr-only" role="status">
          {downloadMessage}
        </p>
      )}
      {downloadError && (
        <p className="text-xs text-red-700" role="alert">
          {downloadError}
        </p>
      )}
      <Button
        variant={"destructive"}
        className="m-0 text-sm"
        onClick={clearCanvas}
      >
        Clear
        <Trash2 className="h-4 w-4" />
      </Button>
    </>
  );
};

// If mobile, canvas galleries are in a popover with an image icon trigger.
// If desktop, canvas galleries are in a sidebar.
const CanvasStickers = ({
  isMobile,
  onImageClick,
  categories,
  isLoading,
  hasError,
  onRetry,
}: {
  isMobile: boolean;
  onImageClick: (imageData: {
    url: string;
    alt?: string;
    isNsfw?: boolean;
  }) => void;
  categories: Category[];
  isLoading: boolean;
  hasError: boolean;
  onRetry: () => void;
}) => {
  const [stickersOpen, setStickersOpen] = useState(false);
  return (
    <div className={isMobile ? undefined : "h-full min-h-0 overflow-hidden"}>
      {isMobile ? (
        <Popover open={stickersOpen} onOpenChange={setStickersOpen}>
          <PopoverTrigger asChild>
            <Button
              variant={"outline"}
              className="m-0 text-sm"
              disabled={isLoading}
              aria-label={
                isLoading
                  ? "Loading stickers"
                  : hasError
                    ? "Stickers unavailable"
                    : "Open stickers"
              }
            >
              <ImageIcon className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="h-[min(80vh,500px)] overflow-hidden p-0">
            {hasError ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
                <p className="text-sm text-muted-foreground">
                  Stickers could not be loaded.
                </p>
                <Button variant="outline" size="sm" onClick={onRetry}>
                  Try again
                </Button>
              </div>
            ) : (
              <CanvasGalleries
                isMobile={isMobile}
                onImageClick={onImageClick}
                categories={categories}
                setStickersOpen={setStickersOpen}
              />
            )}
          </PopoverContent>
        </Popover>
      ) : hasError ? (
        <div className="flex h-full w-[200px] flex-col items-center justify-center gap-3 p-4 text-center">
          <p className="text-sm text-muted-foreground">
            Stickers could not be loaded.
          </p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : isLoading ? (
        <StickerPanelSkeleton />
      ) : (
        <CanvasGalleries
          isMobile={isMobile}
          onImageClick={onImageClick}
          categories={categories}
        />
      )}
    </div>
  );
};

function StickerPanelSkeleton() {
  return (
    <div
      className="flex h-full w-[200px] flex-col gap-3 p-3"
      role="status"
      aria-label="Loading stickers"
    >
      <div className="h-9 animate-pulse rounded-md bg-muted" />
      <div className="h-20 animate-pulse rounded-md bg-muted" />
      <div className="h-20 animate-pulse rounded-md bg-muted" />
      <div className="h-20 animate-pulse rounded-md bg-muted" />
    </div>
  );
}
