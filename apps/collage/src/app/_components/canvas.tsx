"use client";
import { cn } from "@/lib/utils";
import { type SerializedCanvasObject } from "@/types/canvas";
import {
  ActiveSelection,
  Canvas,
  type CanvasEvents,
  Group as FabricGroup,
  FabricImage,
  type FabricObject,
  Gradient,
} from "fabric";
import {
  BringToFront,
  FlipHorizontal2,
  FlipVertical2,
  Group as GroupIcon,
  MoveDown,
  MoveUp,
  SendToBack,
  Trash2,
  Ungroup,
} from "lucide-react";
import { type RefObject, useEffect, useRef } from "react";
import {
  dataUrlToBlob,
  type ImageSaveResult,
  saveImageBlob,
} from "./download-utils";
import { type BackgroundValue } from "./gradient-picker";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./ui/context-menu";
import { useSidebar } from "./ui/sidebar";

type CanvasComponentProps = {
  backgroundColor: BackgroundValue;
  fabricCanvasRef: RefObject<Canvas | null>;
  className?: string;
  canvasJson?: { objects: SerializedCanvasObject[] };
  setObjects: (objects: SerializedCanvasObject[]) => void;
  hasSelection: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onSelectionChange?: (selected: boolean) => void;
};

const CANVAS_DESIGN_SIZE = 800;
const CANVAS_BACKGROUND_IMAGE_WIDTH = 1920;

function getCanvasBackgroundImageUrl(src: string): string {
  try {
    const sourceUrl = new URL(src, window.location.origin);
    if (sourceUrl.origin === window.location.origin) {
      return sourceUrl.href;
    }

    const optimizedUrl = new URL("/_next/image", window.location.origin);
    optimizedUrl.searchParams.set("url", sourceUrl.href);
    optimizedUrl.searchParams.set(
      "w",
      CANVAS_BACKGROUND_IMAGE_WIDTH.toString(),
    );
    optimizedUrl.searchParams.set("q", "75");
    return optimizedUrl.href;
  } catch {
    return src;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function serializeCanvasObjects(
  canvas: Canvas,
): SerializedCanvasObject[] {
  const jsonData: unknown = canvas.toObject(["src", "alt", "isNsfw"]);
  if (!isRecord(jsonData) || !Array.isArray(jsonData.objects)) {
    throw new Error("Fabric returned an invalid serialized canvas.");
  }
  return jsonData.objects.filter(isRecord);
}

function persistCanvasObjects(
  canvas: Canvas,
  setObjects: (objects: SerializedCanvasObject[]) => void,
) {
  setObjects(serializeCanvasObjects(canvas));
}

// Type guard to check if an object is an ActiveSelection
function isActiveSelection(obj: FabricObject): obj is ActiveSelection {
  return obj instanceof ActiveSelection;
}

function isFabricGroup(obj: FabricObject): obj is FabricGroup {
  return obj.type === "group";
}

function configureCanvasObject(obj: FabricObject) {
  obj.set({
    borderColor: "black",
    cornerColor: "black",
    cornerStyle: "circle",
    transparentCorners: true,
    lockUniScaling: true,
    uniformScaling: true,
    hasControls: true,
  });

  if (obj.controls) {
    const middleControls = ["ml", "mr", "mt", "mb"];
    for (const control of middleControls) {
      const controlObj = obj.controls[control];
      if (controlObj) {
        controlObj.visible = false;
      }
    }
  }
}

function setObjectBordersBlack(canvas: Canvas) {
  canvas.getObjects().forEach(configureCanvasObject);
}

function clearEmptyObjects(canvas: Canvas) {
  canvas.getObjects().forEach((obj) => {
    if (
      isActiveSelection(obj) &&
      (!obj._objects || obj._objects.length === 0)
    ) {
      canvas.remove(obj);
    }
  });
}

export function handleDelete(
  canvas: Canvas | null,
  setObjects: (objects: SerializedCanvasObject[]) => void,
) {
  if (!canvas) return;
  const activeObjects = canvas.getActiveObjects();

  if (activeObjects.length) {
    activeObjects.forEach((obj) => canvas.remove(obj));
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    persistCanvasObjects(canvas, setObjects);
  }
}

export function handleFlipX(
  canvas: Canvas | null,
  setObjects: (objects: SerializedCanvasObject[]) => void,
) {
  if (!canvas) return;
  const activeObject = canvas.getActiveObject();
  if (activeObject) {
    activeObject.flipX = !activeObject.flipX;
    canvas.requestRenderAll();
    persistCanvasObjects(canvas, setObjects);
  }
}

export function handleFlipY(
  canvas: Canvas | null,
  setObjects: (objects: SerializedCanvasObject[]) => void,
) {
  if (!canvas) return;
  const activeObject = canvas.getActiveObject();
  if (activeObject) {
    activeObject.flipY = !activeObject.flipY;
    canvas.requestRenderAll();
    persistCanvasObjects(canvas, setObjects);
  }
}

function handleMoveForward(
  canvas: Canvas | null,
  setObjects: (objects: SerializedCanvasObject[]) => void,
) {
  const activeObject = canvas?.getActiveObject();
  if (!canvas || !activeObject) return;
  canvas.bringObjectForward(activeObject);
  canvas.requestRenderAll();
  persistCanvasObjects(canvas, setObjects);
}

function handleBringToFront(
  canvas: Canvas | null,
  setObjects: (objects: SerializedCanvasObject[]) => void,
) {
  const activeObject = canvas?.getActiveObject();
  if (!canvas || !activeObject) return;
  canvas.bringObjectToFront(activeObject);
  canvas.requestRenderAll();
  persistCanvasObjects(canvas, setObjects);
}

function handleMoveBackward(
  canvas: Canvas | null,
  setObjects: (objects: SerializedCanvasObject[]) => void,
) {
  const activeObject = canvas?.getActiveObject();
  if (!canvas || !activeObject) return;
  canvas.sendObjectBackwards(activeObject);
  canvas.requestRenderAll();
  persistCanvasObjects(canvas, setObjects);
}

function handleSendToBack(
  canvas: Canvas | null,
  setObjects: (objects: SerializedCanvasObject[]) => void,
) {
  const activeObject = canvas?.getActiveObject();
  if (!canvas || !activeObject) return;
  canvas.sendObjectToBack(activeObject);
  canvas.requestRenderAll();
  persistCanvasObjects(canvas, setObjects);
}

export async function handleDuplicate(
  canvas: Canvas,
  setObjects: (objects: SerializedCanvasObject[]) => void,
) {
  const activeObject = canvas.getActiveObject();
  if (!activeObject) return;

  const duplicateOffset = 20;
  const clonedObject = await activeObject.clone();
  clonedObject.set({
    left: (activeObject.left ?? 0) + duplicateOffset,
    top: (activeObject.top ?? 0) + duplicateOffset,
  });

  canvas.discardActiveObject();
  if (clonedObject instanceof ActiveSelection) {
    const clonedObjects = clonedObject.removeAll();
    canvas.add(...clonedObjects);
    canvas.setActiveObject(new ActiveSelection(clonedObjects, { canvas }));
  } else {
    canvas.add(clonedObject);
    canvas.setActiveObject(clonedObject);
  }

  canvas.requestRenderAll();
  persistCanvasObjects(canvas, setObjects);
}

function CanvasComponent({
  fabricCanvasRef,
  className,
  canvasJson,
  backgroundColor,
  setObjects,
  hasSelection,
  onUndo,
  onRedo,
  onSelectionChange,
}: CanvasComponentProps) {
  const { isMobile } = useSidebar();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasElementRef = useRef<HTMLCanvasElement>(null);
  const initialDistanceRef = useRef<number | null>(null);
  const initialScaleRef = useRef<number | null>(null);
  const clipboardRef = useRef<FabricObject[] | null>(null);
  const wheelHistoryTimerRef = useRef<number | undefined>(undefined);
  const initialSizeRef = useRef<boolean>(false);
  const initialCanvasJsonRef = useRef(canvasJson);
  const initialBackgroundColorRef = useRef(backgroundColor);

  // Force a resize on component mount
  useEffect(() => {
    if (!initialSizeRef.current && fabricCanvasRef.current) {
      initialSizeRef.current = true;

      const canvas = fabricCanvasRef.current;

      // Get the container dimensions if available
      const containerWidth =
        containerRef.current?.clientWidth ?? window.innerWidth;
      const containerHeight =
        containerRef.current?.parentElement?.clientHeight ?? window.innerHeight;

      // For a square canvas, use the smaller dimension to ensure it fits
      const availableSpace = Math.min(containerWidth, containerHeight);

      // Maintain aspect ratio (canvas is always square in this case)
      const ratio = 1; // width/height ratio (1 for square)

      // Calculate the appropriate size based on available space
      // No minimum size constraint for mobile
      const targetSize = Math.min(
        isMobile ? window.innerWidth - 20 : 800,
        availableSpace,
      );
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
  }, [fabricCanvasRef, isMobile]);

  useEffect(() => {
    updateCanvasBackground({
      fabricCanvasRef,
      storeBackgroundColor: backgroundColor,
    });
  }, [backgroundColor, fabricCanvasRef]);

  // Initialize canvas and set up ALL event handlers
  useEffect(() => {
    if (!canvasElementRef.current) return;

    // Only create canvas if it doesn't exist
    if (!fabricCanvasRef.current) {
      // Get initial container dimensions if available
      const containerWidth =
        containerRef.current?.clientWidth ?? window.innerWidth;
      const containerHeight =
        containerRef.current?.parentElement?.clientHeight ?? window.innerHeight;

      // For a square canvas, use the smaller dimension to ensure it fits
      const availableSpace = Math.min(containerWidth, containerHeight);

      const initialSize = Math.min(
        isMobile ? window.innerWidth - 20 : 800,
        availableSpace,
      );

      // Create canvas with initial dimensions
      const fabricCanvas = new Canvas(canvasElementRef.current, {
        width: initialSize,
        height: initialSize,
        preserveObjectStacking: true,
        selectionKey: "shiftKey",
        uniformScaling: true,
        uniScaleTransform: true,
        uniformScalingWithFlip: true,
        // Radix owns the menu. Fabric's default prevents the event from
        // reaching the context-menu trigger around its interaction canvas.
        stopContextMenu: false,
      });

      fabricCanvasRef.current = fabricCanvas;

      // Load initial state from canvasJson prop if present or if we have a background
      const initialCanvasJson = initialCanvasJsonRef.current;
      const initialBackgroundColor = initialBackgroundColorRef.current;
      if (initialCanvasJson || initialBackgroundColor) {
        void fabricCanvas.loadFromJSON(
          {
            objects: initialCanvasJson?.objects ?? [],
            background: initialBackgroundColor,
          },
          () => {
            updateCanvasBackground({
              fabricCanvasRef,
              storeBackgroundColor: initialBackgroundColor,
            });
            fabricCanvas.requestRenderAll();
            // Only update objects state if we have objects
            if (initialCanvasJson?.objects) {
              setObjects(initialCanvasJson.objects);
            }

            // Force a resize immediately after initialization
            setTimeout(() => {
              if (containerRef.current && fabricCanvasRef.current) {
                const container = containerRef.current;
                const canvas = fabricCanvasRef.current;

                // Get the container dimensions
                const containerWidth = container.clientWidth;
                const containerHeight =
                  container.parentElement?.clientHeight ?? window.innerHeight;

                // For a square canvas, use the smaller dimension to ensure it fits
                const availableSpace = Math.min(
                  containerWidth,
                  containerHeight,
                );

                // Maintain aspect ratio (canvas is always square in this case)
                const ratio = 1; // width/height ratio (1 for square)

                // No minimum size constraint for mobile
                const targetSize = Math.min(
                  isMobile ? window.innerWidth - 20 : 800,
                  availableSpace,
                );
                const targetWidth = targetSize;
                const targetHeight = targetSize / ratio;

                // Calculate the scale factor
                const originalWidth = 800; // The design width
                const scale = targetWidth / originalWidth;

                // Update canvas dimensions
                canvas.setDimensions({
                  width: targetWidth,
                  height: targetHeight,
                });

                // Scale the canvas content accordingly
                canvas.setViewportTransform([scale, 0, 0, scale, 0, 0]);

                canvas.requestRenderAll();
              }
            }, 0);
          },
        );
      }
    }

    const fabricCanvas = fabricCanvasRef.current;

    // Set uniform scaling for all objects
    const configureAddedObject = (e: CanvasEvents["object:added"]) => {
      if (e.target) {
        configureCanvasObject(e.target);
      }
    };
    fabricCanvas.on("object:added", configureAddedObject);

    // Ensure all existing objects have uniform scaling enabled
    fabricCanvas.getObjects().forEach((obj) => {
      obj.set({
        lockUniScaling: true,
        uniformScaling: true,
      });
    });

    setObjectBordersBlack(fabricCanvas);

    clearEmptyObjects(fabricCanvas);

    // Add selection event handlers
    const handleSelectionCreated = () => {
      onSelectionChange?.(true);
    };
    fabricCanvas.on("selection:created", handleSelectionCreated);

    const handleSelectionUpdated = () => {
      onSelectionChange?.(true);
    };
    fabricCanvas.on("selection:updated", handleSelectionUpdated);

    const handleSelectionCleared = () => {
      onSelectionChange?.(false);
    };
    fabricCanvas.on("selection:cleared", handleSelectionCleared);

    const handleCanvasContextMenu = (event: CanvasEvents["contextmenu"]) => {
      if (!event.target) return;
      fabricCanvas.setActiveObject(event.target);
      onSelectionChange?.(true);
      fabricCanvas.requestRenderAll();
    };
    fabricCanvas.on("contextmenu", handleCanvasContextMenu);

    // Keep all existing event handlers
    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const touch1 = e.touches[0];
        const touch2 = e.touches[1];
        if (!touch1 || !touch2) return;
        const dx = touch2.pageX - touch1.pageX;
        const dy = touch2.pageY - touch1.pageY;
        initialDistanceRef.current = Math.hypot(dx, dy);

        const activeObject = fabricCanvas.getActiveObject();
        if (activeObject) {
          initialScaleRef.current = activeObject.scaleX;
        }
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (
        e.touches.length === 2 &&
        initialDistanceRef.current &&
        initialScaleRef.current !== null
      ) {
        e.preventDefault();
        const touch1 = e.touches[0];
        const touch2 = e.touches[1];
        if (!touch1 || !touch2) return;
        const dx = touch2.pageX - touch1.pageX;
        const dy = touch2.pageY - touch1.pageY;
        const currentDistance = Math.hypot(dx, dy);

        const scaleFactor = currentDistance / initialDistanceRef.current;
        const activeObject = fabricCanvas.getActiveObject();
        if (activeObject) {
          const newScale = initialScaleRef.current * scaleFactor;
          activeObject.set({
            scaleX: newScale,
            scaleY: newScale,
          });
          fabricCanvas.renderAll();
        }
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        initialDistanceRef.current = null;
        initialScaleRef.current = null;
        persistCanvasObjects(fabricCanvas, setObjects);
      }
    };

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const activeObject = fabricCanvas.getActiveObject();
        if (!activeObject) return;

        const delta = -e.deltaY / 400;
        const currentScale = activeObject.scaleX || 1;
        const newScale = currentScale * (1 + delta);

        const constrainedScale = Math.min(Math.max(newScale, 0.1), 5);
        activeObject.set({
          scaleX: constrainedScale,
          scaleY: constrainedScale,
        });
        fabricCanvas.requestRenderAll();
        window.clearTimeout(wheelHistoryTimerRef.current);
        wheelHistoryTimerRef.current = window.setTimeout(() => {
          persistCanvasObjects(fabricCanvas, setObjects);
        }, 200);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!fabricCanvasRef.current) return;
      const activeElement = document.activeElement;
      if (
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement ||
        activeElement instanceof HTMLSelectElement ||
        activeElement?.getAttribute("contenteditable") === "true"
      ) {
        return;
      }

      const canvas = fabricCanvasRef.current;
      const activeObjects = canvas.getActiveObjects();

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) {
          onRedo();
        } else {
          onUndo();
        }
        return;
      }

      if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "y") {
        e.preventDefault();
        onRedo();
        return;
      }

      if (
        (e.metaKey || e.ctrlKey) &&
        (e.code === "BracketLeft" || e.code === "BracketRight") &&
        activeObjects.length > 0
      ) {
        e.preventDefault();
        if (e.code === "BracketRight") {
          if (e.shiftKey) {
            handleBringToFront(canvas, setObjects);
          } else {
            handleMoveForward(canvas, setObjects);
          }
        } else if (e.shiftKey) {
          handleSendToBack(canvas, setObjects);
        } else {
          handleMoveBackward(canvas, setObjects);
        }
        return;
      }

      // Group (Ctrl + G)
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key === "g" &&
        !e.shiftKey &&
        activeObjects.length > 1
      ) {
        e.preventDefault();
        const group = new FabricGroup(activeObjects);
        canvas.remove(...activeObjects);
        canvas.add(group);
        canvas.setActiveObject(group);
        canvas.requestRenderAll();
        persistCanvasObjects(canvas, setObjects);
      }

      // Ungroup (Ctrl + Shift + G)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "g") {
        handleUngroup({ fabricCanvasRef, setObjects });
      }

      // Delete
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        activeObjects.length > 0
      ) {
        e.preventDefault();
        handleDelete(canvas, setObjects);
      }

      // Copy (Cmd/Ctrl + C)
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key === "c" &&
        activeObjects.length > 0
      ) {
        e.preventDefault();
        void Promise.all(activeObjects.map((obj) => obj.clone())).then(
          (clonedObjects) => {
            clipboardRef.current = clonedObjects;
          },
        );
      }

      // Paste (Cmd/Ctrl + V)
      if ((e.metaKey || e.ctrlKey) && e.key === "v" && clipboardRef.current) {
        e.preventDefault();
        if (Array.isArray(clipboardRef.current)) {
          void Promise.all(clipboardRef.current.map((obj) => obj.clone())).then(
            (clonedObjects) => {
              clonedObjects.forEach((cloned) => {
                cloned.set({
                  left: (cloned.left || 0) + 10,
                  top: (cloned.top || 0) + 10,
                });
                canvas.add(cloned);
              });
              canvas.discardActiveObject();
              const selection = new ActiveSelection(clonedObjects, {
                canvas,
              });
              canvas.setActiveObject(selection);
              canvas.requestRenderAll();
              persistCanvasObjects(canvas, setObjects);
            },
          );
        }
      }

      // Duplicate (Cmd/Ctrl + D)
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key === "d" &&
        activeObjects.length > 0
      ) {
        e.preventDefault();
        void handleDuplicate(canvas, setObjects);
      }
    };

    // Attach all event handlers
    const container = containerRef.current;
    if (container) {
      container.addEventListener("wheel", handleWheel, { passive: false });
      container.addEventListener("touchstart", handleTouchStart, {
        passive: false,
      });
      container.addEventListener("touchmove", handleTouchMove, {
        passive: false,
      });
      container.addEventListener("touchend", handleTouchEnd, {
        passive: false,
      });
    }

    window.addEventListener("keydown", handleKeyDown);

    fabricCanvas.requestRenderAll();

    const persistObjects = () => {
      persistCanvasObjects(fabricCanvas, setObjects);
    };
    fabricCanvas.on("object:modified", persistObjects);

    // Cleanup function
    return () => {
      if (container) {
        container.removeEventListener("wheel", handleWheel);
        container.removeEventListener("touchstart", handleTouchStart);
        container.removeEventListener("touchmove", handleTouchMove);
        container.removeEventListener("touchend", handleTouchEnd);
      }
      window.removeEventListener("keydown", handleKeyDown);
      window.clearTimeout(wheelHistoryTimerRef.current);
      fabricCanvas.off("object:added", configureAddedObject);
      fabricCanvas.off("selection:created", handleSelectionCreated);
      fabricCanvas.off("selection:updated", handleSelectionUpdated);
      fabricCanvas.off("selection:cleared", handleSelectionCleared);
      fabricCanvas.off("contextmenu", handleCanvasContextMenu);
      fabricCanvas.off("object:modified", persistObjects);
    };
  }, [
    setObjects,
    fabricCanvasRef,
    isMobile,
    onRedo,
    onUndo,
    onSelectionChange,
  ]);

  // Simplified resize handler that uses ratio-based scaling
  useEffect(() => {
    const handleResize = () => {
      if (!containerRef.current || !fabricCanvasRef.current) return;

      const canvas = fabricCanvasRef.current;
      const container = containerRef.current;

      // Get the parent container dimensions
      const containerWidth = container.clientWidth;
      const containerHeight =
        container.parentElement?.clientHeight ?? window.innerHeight;

      // For a square canvas, we want to fit within both width and height constraints
      // Use the smaller of the two dimensions to ensure it fits completely
      const availableSpace = Math.min(containerWidth, containerHeight);

      // Maintain aspect ratio (canvas is always square in this case)
      const ratio = 1; // width/height ratio (1 for square)

      // Calculate the appropriate size based on available space
      // No minimum size constraint for mobile
      const targetSize = Math.min(
        isMobile ? window.innerWidth - 20 : 800,
        availableSpace,
      );
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
    };

    // Run the resize handler immediately after the component mounts
    handleResize();

    // Also run after delays to ensure proper sizing
    setTimeout(handleResize, 100);
    setTimeout(handleResize, 500);

    // Add event listeners
    window.addEventListener("resize", handleResize);
    window.addEventListener("orientationchange", handleResize);

    // Create a ResizeObserver
    const resizeObserver = new ResizeObserver(() => {
      handleResize();
    });

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
      if (containerRef.current.parentElement) {
        resizeObserver.observe(containerRef.current.parentElement);
      }
    }

    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("orientationchange", handleResize);
      resizeObserver.disconnect();
    };
  }, [fabricCanvasRef, isMobile]);

  return (
    <div className={cn("flex aspect-square h-full w-full flex-col", className)}>
      <div className="relative flex aspect-square h-full w-full items-center justify-center">
        <div
          ref={containerRef}
          style={{
            touchAction: "none",
            position: "relative",
            WebkitUserSelect: "none",
            userSelect: "none",
            width: "100%",
            height: "100%",
            aspectRatio: "1/1",
            maxWidth: isMobile ? "100%" : "800px",
            maxHeight: isMobile ? "100%" : "800px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          className="canvas-container-wrapper w-full"
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }}
          onDrop={(e) => {
            e.preventDefault();
            // Retrieve and parse the JSON data.
            const data = e.dataTransfer.getData("text/plain");
            let dragData: { url: string; alt?: string; isNsfw?: boolean } = {
              url: "",
            };

            try {
              dragData = JSON.parse(data) as {
                url: string;
                alt?: string;
                isNsfw?: boolean;
              };
            } catch {
              dragData.url = data;
            }
            const imageUrl = dragData.url;
            if (!imageUrl) return;

            const rect = e.currentTarget.getBoundingClientRect();
            const left = e.clientX - rect.left;
            const top = e.clientY - rect.top;

            void FabricImage.fromURL(imageUrl, {
              crossOrigin: "anonymous",
            }).then((img) => {
              if (!fabricCanvasRef.current) return;

              // Define maximum dimensions.
              const maxWidth = 300;
              const maxHeight = 300;
              const scale = Math.min(
                maxWidth / img.width,
                maxHeight / img.height,
                1,
              );

              img.set({
                left,
                top,
                cornerStyle: "circle",
                transparentCorners: false,
                scaleX: scale,
                scaleY: scale,
                lockUniScaling: true,
                uniformScaling: true,
                isNsfw: dragData.isNsfw,
                src: imageUrl,
                alt: dragData.alt,
              });

              fabricCanvasRef.current.add(img);
              fabricCanvasRef.current.setActiveObject(img);
              fabricCanvasRef.current.requestRenderAll();
              persistCanvasObjects(fabricCanvasRef.current, setObjects);
            });
          }}
        >
          <ContextMenu>
            <ContextMenuTrigger>
              <canvas ref={canvasElementRef} />
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem
                disabled={!hasSelection}
                onSelect={() =>
                  handleBringToFront(fabricCanvasRef.current, setObjects)
                }
              >
                <BringToFront className="mr-2 h-4 w-4" /> Bring to Front
                <span className="ml-auto pl-4 text-xs text-muted-foreground">
                  ⌘⇧]
                </span>
              </ContextMenuItem>
              <ContextMenuItem
                disabled={!hasSelection}
                onSelect={() =>
                  handleDelete(fabricCanvasRef.current, setObjects)
                }
              >
                <Trash2 className="mr-2 h-4 w-4" /> Delete
              </ContextMenuItem>
              <ContextMenuItem
                disabled={!hasSelection}
                onSelect={() => handleGroup(fabricCanvasRef, setObjects)}
              >
                <GroupIcon className="mr-2 h-4 w-4" /> Group
              </ContextMenuItem>
              <ContextMenuItem
                disabled={!hasSelection}
                onSelect={() => handleUngroup({ fabricCanvasRef, setObjects })}
              >
                <Ungroup className="mr-2 h-4 w-4" /> Ungroup
              </ContextMenuItem>
              <ContextMenuItem
                disabled={!hasSelection}
                onSelect={() =>
                  handleFlipX(fabricCanvasRef.current, setObjects)
                }
              >
                <FlipHorizontal2 className="mr-2 h-4 w-4" /> Flip Horizontally
              </ContextMenuItem>
              <ContextMenuItem
                disabled={!hasSelection}
                onSelect={() =>
                  handleFlipY(fabricCanvasRef.current, setObjects)
                }
              >
                <FlipVertical2 className="mr-2 h-4 w-4" /> Flip Vertically
              </ContextMenuItem>
              <ContextMenuItem
                disabled={!hasSelection}
                onSelect={() =>
                  handleMoveForward(fabricCanvasRef.current, setObjects)
                }
              >
                <MoveUp className="mr-2 h-4 w-4" /> Move Forward
                <span className="ml-auto pl-4 text-xs text-muted-foreground">
                  ⌘]
                </span>
              </ContextMenuItem>
              <ContextMenuItem
                disabled={!hasSelection}
                onSelect={() =>
                  handleMoveBackward(fabricCanvasRef.current, setObjects)
                }
              >
                <MoveDown className="mr-2 h-4 w-4" /> Move Backward
                <span className="ml-auto pl-4 text-xs text-muted-foreground">
                  ⌘[
                </span>
              </ContextMenuItem>
              <ContextMenuItem
                disabled={!hasSelection}
                onSelect={() =>
                  handleSendToBack(fabricCanvasRef.current, setObjects)
                }
              >
                <SendToBack className="mr-2 h-4 w-4" /> Send to Back
                <span className="ml-auto pl-4 text-xs text-muted-foreground">
                  ⌘⇧[
                </span>
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </div>
      </div>
    </div>
  );
}

export default CanvasComponent;

export const updateCanvasBackground = ({
  fabricCanvasRef,
  storeBackgroundColor,
}: {
  fabricCanvasRef: RefObject<Canvas | null>;
  storeBackgroundColor: BackgroundValue;
}) => {
  if (!fabricCanvasRef.current) return;
  const canvas = fabricCanvasRef.current;

  // Solid color background
  if (typeof storeBackgroundColor === "string") {
    canvas.backgroundColor = storeBackgroundColor;
    canvas.backgroundImage = undefined;
    canvas.requestRenderAll();
  }
  // Image background
  else if (storeBackgroundColor && "src" in storeBackgroundColor) {
    const canvasImageUrl = getCanvasBackgroundImageUrl(
      storeBackgroundColor.src,
    );
    void FabricImage.fromURL(canvasImageUrl, {
      crossOrigin: "anonymous",
    })
      .then((img) => {
        if (fabricCanvasRef.current !== canvas || !img.width || !img.height) {
          return;
        }

        const coverScale = Math.max(
          CANVAS_DESIGN_SIZE / img.width,
          CANVAS_DESIGN_SIZE / img.height,
        );
        img.set({
          evented: false,
          left: CANVAS_DESIGN_SIZE / 2,
          originX: "center",
          originY: "center",
          selectable: false,
          top: CANVAS_DESIGN_SIZE / 2,
          scaleX: coverScale,
          scaleY: coverScale,
        });
        canvas.set({ backgroundColor: "", backgroundImage: img });
        canvas.requestRenderAll();
      })
      .catch((error: unknown) => {
        console.error("Failed to load canvas background image", error);
      });
  }
  // Gradient background
  else if (
    storeBackgroundColor &&
    "type" in storeBackgroundColor &&
    storeBackgroundColor.type === "gradient"
  ) {
    const gradient = new Gradient({
      type: "linear",
      coords: storeBackgroundColor.coords,
      colorStops: storeBackgroundColor.colorStops,
      gradientUnits: "pixels",
    });
    canvas.backgroundColor = gradient;
    canvas.backgroundImage = undefined;
    canvas.requestRenderAll();
  }
};

export const handleDownloadCanvas = (
  fabricCanvasRef: RefObject<Canvas | null>,
): Promise<ImageSaveResult> => {
  if (!fabricCanvasRef.current) {
    return Promise.reject(new Error("The collage canvas is not ready."));
  }

  const canvas = fabricCanvasRef.current;
  const activeObject = canvas.getActiveObject();

  // Temporarily disable selection borders and controls
  const objects = canvas.getObjects();
  const originalBorders = objects.map((obj) => ({
    obj,
    hasControls: obj.hasControls,
    hasBorders: obj.hasBorders,
    selectable: obj.selectable,
  }));

  try {
    objects.forEach((obj) => {
      obj.hasControls = false;
      obj.hasBorders = false;
      obj.selectable = false;
    });

    canvas.discardActiveObject();
    canvas.requestRenderAll();

    const desiredResolution = 1080;
    const multiplier = desiredResolution / canvas.getWidth();
    const dataUrl = canvas.toDataURL({
      format: "png",
      quality: 1,
      multiplier,
    });
    const blob = dataUrlToBlob(dataUrl);

    // Calling this before yielding preserves the user gesture required by iOS.
    return saveImageBlob(blob, "maya-collage.png");
  } finally {
    originalBorders.forEach(({ obj, hasControls, hasBorders, selectable }) => {
      obj.hasControls = hasControls;
      obj.hasBorders = hasBorders;
      obj.selectable = selectable;
    });
    if (activeObject) {
      canvas.setActiveObject(activeObject);
    }
    canvas.requestRenderAll();
  }
};

const handleGroup = (
  fabricCanvasRef: RefObject<Canvas | null>,
  setObjects: (objects: SerializedCanvasObject[]) => void,
) => {
  if (!fabricCanvasRef.current) return;
  const canvas = fabricCanvasRef.current;
  const activeObjects = canvas.getActiveObjects();
  if (activeObjects.length < 2) return;

  const group = new FabricGroup(activeObjects);
  canvas.remove(...activeObjects);
  canvas.add(group);
  canvas.setActiveObject(group);
  canvas.requestRenderAll();
  persistCanvasObjects(canvas, setObjects);
};

const handleUngroup = ({
  fabricCanvasRef,
  setObjects,
}: {
  fabricCanvasRef: RefObject<Canvas | null>;
  setObjects: (objects: SerializedCanvasObject[]) => void;
}) => {
  if (!fabricCanvasRef.current) return;
  const canvas = fabricCanvasRef.current;
  const activeObject = canvas.getActiveObject();

  // Only proceed if there is an active object and it's a group.
  if (!activeObject || !isFabricGroup(activeObject)) return;

  // Use removeAll() to remove all children from the group.
  // removeAll() returns an array of the removed objects.
  const items = activeObject.removeAll();

  // Add all the removed objects back to the canvas.
  canvas.add(...items);

  // Remove the now-empty group from the canvas.
  canvas.remove(activeObject);

  // Update the canvas.
  canvas.requestRenderAll();

  // Optionally, update your persisted state.
  persistCanvasObjects(canvas, setObjects);
};
