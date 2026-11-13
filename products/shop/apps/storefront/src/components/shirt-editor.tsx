"use client";

import { safeErrorDetails } from "@forever-tee/contracts/diagnostics";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateConfiguredProductFamilyRequest,
  ProductDefaultColor,
} from "@forever-tee/contracts";
import type { BaseProductSlug } from "@forever-tee/contracts/product-projection";
import {
  MAX_DESIGN_SOURCE_BYTES,
  MAX_DESIGN_SOURCE_EDGE,
  MAX_DESIGN_SOURCE_PIXELS,
} from "@forever-tee/contracts/limits";
import { projectEditorPlacement } from "@forever-tee/contracts/product-projection";
import { CheckIcon, SwitchCameraIcon, TimerIcon } from "lucide-react";

import { useNavigate } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import type { PointerEvent } from "react";

import { TurnstileChallenge } from "@/components/turnstile-challenge";
import { Button } from "@/components/ui/button";
import {
  takeCameraForDraft,
  discardCameraHandoff,
} from "@/client/camera-handoff";
import {
  hasMultipleCameras,
  requestCameraStream,
  type CameraFacing,
} from "@/client/camera-stream";
import { takeImageForDraft } from "@/client/image-handoff";
import { IMAGE_UPLOAD_ACCEPT, prepareImageUpload } from "@/client/image-upload";
import { reportCreationTrace } from "@/client/creation-trace";
import {
  getArtworkPreview,
  getArtworkSourcePreview,
  retryArtworkPreparation,
  processDesignArtwork,
  updateDesignSettings,
} from "@/client/design-api";
import { retainProductPreview } from "@/client/product-preview";
import { createConfiguredProductFamily } from "@/client/product-api";
import { artworkPreviewQueryKey, designQueryKey } from "@/client/query-keys";
import {
  errorMessage,
  retryServerMutation,
  serverMutationRetryDelay,
} from "@/client/query-retry";
import { CameraPreparingIndicator } from "@/components/camera-preparing";
import { ProcessedCutoutReveal } from "@/components/processed-cutout-reveal";
import { EditorMinimap } from "@/components/editor-minimap";
import { ProcessingPiercingLoader } from "@/components/processing-piercing-loader";
import { DesignPageSkeleton } from "@/components/route-skeletons";
import { useViewportScrollLock } from "@/hooks/use-viewport-scroll-lock";
import { cn } from "@/lib/utils";
import {
  createAnimationFrameScheduler,
  type AnimationFrameScheduler,
} from "@/lib/animation-frame-scheduler";
import {
  DEFAULT_SETTINGS,
  PREVIEW_HEIGHT,
  PREVIEW_WIDTH,
  canvasToBlob,
  renderRecursiveImage,
  suggestSettings,
} from "@/lib/recursive-image";
import type { EditorSettings } from "@/lib/recursive-image";
import { LAUNCH_BASE_PRODUCTS, productPath } from "@/lib/products";
import { createLatestPersistence } from "@/client/latest-persistence";
import {
  applyDirectManipulation,
  editingLayerAtPoint,
  gestureMetrics,
  type EditingLayer,
  type GestureMetrics,
  type PointerPosition,
} from "@/lib/editor-direct-manipulation";

type ProcessingState = "empty" | "processing" | "revealing" | "ready" | "error";

interface DirectManipulationInteraction {
  layer: EditingLayer;
  pointers: Map<number, PointerPosition>;
  startMetrics: GestureMetrics;
  startSettings: EditorSettings;
}

interface InitialDesign {
  previewReady?: boolean | undefined;
  artworkJobId?: string | null | undefined;
  artworkProcessingStatus?:
    "pending" | "processing" | "complete" | "failed" | null | undefined;
  maximumCropZoom?: number | null | undefined;
  hasOriginalArtwork?: boolean | undefined;
  artworkRevision?: string | null;
  id: string;
  status: "creating" | "ready";
  settings: EditorSettings;
  updatedAt: string;
}

interface PreparedProduct {
  designId: string;
  productId: string;
}

interface ShirtEditorProps {
  uploadLaunch?: boolean;
  defaultColor?: ProductDefaultColor;
  baseProductAvailability?: "available" | "checking" | "unavailable";
  initialDesign?: InitialDesign;
  onRetryProductAvailability?: () => void;
  onContinuationChange?: (pending: boolean) => void;
}

interface CapturedFrame {
  blob: Blob;
  height: number;
  width: number;
}

interface DesignSettingsPersistence {
  designId: string;
  settings: EditorSettings;
}

interface ArtworkProcessingMutation {
  challengeToken?: string | undefined;
  designId: string;
  image: Blob;
  processingId: number;
}

interface SettingsErrorDiagnostics {
  readonly attemptCount: number | undefined;
  readonly code: string | undefined;
  readonly requestId: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly status: number | undefined;
}

const MAXIMUM_PRINT_CAPTURE_EDGE_PX = MAX_DESIGN_SOURCE_EDGE;
const PRINT_CAPTURE_JPEG_QUALITY = 0.94;
const IDEAL_CAMERA_WIDTH_PX = 3_840;

function projectedEditorSettings(
  settings: EditorSettings,
  slug: BaseProductSlug,
): EditorSettings {
  const placement = projectEditorPlacement(settings, slug);
  return {
    ...settings,
    depth: placement.depth,
    placementWidth: placement.width,
    placementX: placement.x,
    placementY: placement.y,
  };
}

function settingsErrorDiagnostics(error: unknown): SettingsErrorDiagnostics {
  if (typeof error !== "object" || error === null) {
    return {
      attemptCount: undefined,
      code: undefined,
      requestId: undefined,
      retryAfterSeconds: undefined,
      status: undefined,
    };
  }
  return {
    attemptCount:
      "attemptCount" in error && typeof error.attemptCount === "number"
        ? error.attemptCount
        : undefined,
    code:
      "code" in error && typeof error.code === "string"
        ? error.code
        : undefined,
    requestId:
      "requestId" in error && typeof error.requestId === "string"
        ? error.requestId
        : undefined,
    retryAfterSeconds:
      "retryAfterSeconds" in error &&
      typeof error.retryAfterSeconds === "number"
        ? error.retryAfterSeconds
        : undefined,
    status:
      "status" in error && typeof error.status === "number"
        ? error.status
        : undefined,
  };
}

export function ShirtEditor({
  uploadLaunch = false,
  baseProductAvailability,
  defaultColor = "White",
  initialDesign,
  onRetryProductAvailability,
  onContinuationChange,
}: ShirtEditorProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [source, setSource] = useState<ImageBitmap>();
  const [hasOriginalArtwork, setHasOriginalArtwork] = useState(
    initialDesign?.hasOriginalArtwork ?? false,
  );
  const [changingBackground, setChangingBackground] = useState(false);
  const [pendingBackgroundRemoval, setPendingBackgroundRemoval] =
    useState<boolean>();
  const [backgroundError, setBackgroundError] = useState("");
  const [dragging, setDragging] = useState(false);
  const artworkSourcesRef = useRef(new Map<"original" | "cutout", Blob>());
  const recursiveDepthRef = useRef(
    initialDesign && initialDesign.settings.depth > 0
      ? initialDesign.settings.depth
      : DEFAULT_SETTINGS.depth,
  );
  const [activeArtworkJobId, setActiveArtworkJobId] = useState(
    initialDesign?.artworkJobId,
  );
  const [decodedArtworkJobId, setDecodedArtworkJobId] = useState<string>();
  const [finalPreviewError, setFinalPreviewError] = useState("");
  const [finalPreviewAttempt, setFinalPreviewAttempt] = useState(0);
  const [retryingArtwork, setRetryingArtwork] = useState(false);
  const progressiveFailed =
    initialDesign?.artworkJobId === activeArtworkJobId &&
    initialDesign?.artworkProcessingStatus === "failed";
  const finalArtworkPending =
    Boolean(activeArtworkJobId) && decodedArtworkJobId !== activeArtworkJobId;
  const maximumCropZoom = initialDesign?.maximumCropZoom;
  const cropZoomLimit =
    maximumCropZoom === undefined
      ? 2.6
      : Math.max(0.65, maximumCropZoom ?? 0.65);
  const printQualityUnavailable = maximumCropZoom === null;
  const sourceTooSmall =
    typeof maximumCropZoom === "number" && maximumCropZoom < 0.65;
  const [requestedSettings, setSettings] = useState<EditorSettings>(
    initialDesign?.settings ?? DEFAULT_SETTINGS,
  );
  const settings = useMemo(
    () =>
      typeof maximumCropZoom === "number" &&
      requestedSettings.cropZoom > cropZoomLimit
        ? { ...requestedSettings, cropZoom: cropZoomLimit }
        : requestedSettings,
    [requestedSettings, maximumCropZoom, cropZoomLimit],
  );
  const printQualityPending =
    maximumCropZoom !== undefined &&
    initialDesign !== undefined &&
    (settings.removeBackground ?? true) !==
      (initialDesign.settings.removeBackground ?? true);
  const [persistedSettings, setPersistedSettings] = useState<
    EditorSettings | undefined
  >(initialDesign?.settings);
  const [persistedRevision, setPersistedRevision] = useState(
    initialDesign?.updatedAt,
  );
  const [settingsSaveFailed, setSettingsSaveFailed] = useState(false);
  const [continuationPending, setContinuationPending] = useState(false);
  const [navigationPending, startNavigation] = useTransition();
  const [processingState, setProcessingState] =
    useState<ProcessingState>("empty");
  const needsArtworkChallengeRef = useRef(false);
  const challengeRequestRef = useRef<
    ReturnType<typeof Promise.withResolvers<string>> | undefined
  >(undefined);
  const [artworkChallenge, setArtworkChallenge] =
    useState<ReturnType<typeof Promise.withResolvers<string>>>();
  const acceptArtworkChallenge = useCallback(
    (token: string | undefined) => {
      if (
        token &&
        artworkChallenge &&
        challengeRequestRef.current === artworkChallenge
      ) {
        artworkChallenge.resolve(token);
      }
    },
    [artworkChallenge],
  );
  const cancelArtworkChallenge = useCallback(() => {
    const request = challengeRequestRef.current;
    if (request) {
      request.reject(
        new DOMException("Photo processing cancelled.", "AbortError"),
      );
      setProcessingState("error");
    }
    challengeRequestRef.current = undefined;
    setArtworkChallenge(undefined);
  }, []);
  const designId = initialDesign?.id;
  const [artworkReady, setArtworkReady] = useState(
    initialDesign?.status === "ready" || initialDesign?.previewReady === true,
  );
  const [loadsInitialArtwork] = useState(
    initialDesign?.status === "ready" || initialDesign?.previewReady === true,
  );
  const [preparedProduct, setPreparedProduct] = useState<
    PreparedProduct | undefined
  >();
  const [processedCutoutUrl, setProcessedCutoutUrl] = useState("");
  const [capturedPhotoUrl, setCapturedPhotoUrl] = useState("");
  const [revealCovered, setRevealCovered] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream>();
  const [cameraReady, setCameraReady] = useState(false);
  const [multipleCameras, setMultipleCameras] = useState(false);
  const [cameraFacing, setCameraFacing] = useState<CameraFacing>("user");
  const cameraFacingRef = useRef<CameraFacing>("user");
  const cameraSwitchingRef = useRef(false);
  const [cameraError, setCameraError] = useState("");
  const [cameraCountdown, setCameraCountdown] = useState<number>();
  const [cameraTimer, setCameraTimer] = useState<3 | 5 | 10>(3);
  const [reviewingPhoto, setReviewingPhoto] = useState(false);
  const [skipProcessingLoader, setSkipProcessingLoader] = useState(false);
  const [hasPendingPrintFile, setHasPendingPrintFile] = useState(false);
  const [preparingUpload, setPreparingUpload] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadRequestIdRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const minimapCanvasRef = useRef<HTMLCanvasElement>(null);
  const toteMinimapCanvasRef = useRef<HTMLCanvasElement>(null);
  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const cameraStreamRef = useRef<MediaStream | undefined>(undefined);
  const sourceRef = useRef<ImageBitmap | undefined>(undefined);
  const processedCutoutUrlRef = useRef("");
  const capturedPhotoUrlRef = useRef("");
  const settingsRef = useRef(settings);
  const settingsSchedulerRef = useRef<
    AnimationFrameScheduler<EditorSettings> | undefined
  >(undefined);
  const pendingPrintFileRef = useRef<File | undefined>(undefined);
  const directManipulationRef = useRef<
    DirectManipulationInteraction | undefined
  >(undefined);
  const activeLayerTimeoutRef = useRef<number | undefined>(undefined);
  const [activeLayer, setActiveLayer] = useState<EditingLayer>();
  const processingIdRef = useRef(0);
  const creationAttemptIdRef = useRef<string | undefined>(undefined);
  const creationStartedAtRef = useRef(0);
  const cutoutPreparationDurationRef = useRef(0);
  const cameraCaptureIdRef = useRef(0);
  const cameraRequestIdRef = useRef(0);
  const openedDraftCameraRef = useRef(false);
  const scheduleSettings = useCallback((nextSettings: EditorSettings) => {
    let scheduler = settingsSchedulerRef.current;
    if (!scheduler) {
      scheduler = createAnimationFrameScheduler({
        cancelFrame: (handle) => {
          window.cancelAnimationFrame(handle);
        },
        commit: (committedSettings: EditorSettings) => {
          settingsRef.current = committedSettings;
          setSettings(committedSettings);
        },
        requestFrame: (callback) => window.requestAnimationFrame(callback),
      });
      settingsSchedulerRef.current = scheduler;
    }
    scheduler.schedule(nextSettings);
  }, []);
  const flushSettings = useCallback(() => {
    settingsSchedulerRef.current?.flush();
  }, []);
  const resolvedArtworkReady = artworkReady;
  const initialArtworkDesignId =
    loadsInitialArtwork && resolvedArtworkReady && !hasPendingPrintFile
      ? designId
      : undefined;
  const readyDesignSettings = initialDesign?.settings;
  const readyDesignRevision =
    initialDesign?.artworkRevision ?? initialDesign?.updatedAt;
  const initialArtworkQuery = useQuery({
    queryKey: artworkPreviewQueryKey(
      initialArtworkDesignId ?? "unavailable",
      readyDesignRevision,
    ),
    queryFn: () => {
      if (!initialArtworkDesignId) {
        throw new Error("A ready design is required to load artwork.");
      }
      return initialDesign?.artworkJobId
        ? getArtworkSourcePreview(
            initialArtworkDesignId,
            initialDesign.settings.removeBackground === false
              ? "original"
              : "cutout",
          )
        : getArtworkPreview(initialArtworkDesignId, readyDesignRevision);
    },
    enabled: initialArtworkDesignId !== undefined && source === undefined,
    gcTime: Infinity,
    staleTime: Infinity,
  });
  const settingsPersistence = useMemo(
    () =>
      createLatestPersistence({
        isSameValue: (
          left: DesignSettingsPersistence,
          right: DesignSettingsPersistence,
        ) =>
          left.designId === right.designId && left.settings === right.settings,
        onFailure: ({ error }) => {
          const diagnostics = settingsErrorDiagnostics(error);
          setSettingsSaveFailed(true);
          console.error("[bent.shop design] settings save failed", {
            attemptCount: diagnostics.attemptCount,
            code: diagnostics.code,
            ...safeErrorDetails(error),
            requestId: diagnostics.requestId,
            status: diagnostics.status,
          });
        },
        onSuccess: ({ result, value }) => {
          setSettingsSaveFailed(false);
          setPersistedSettings(value.settings);
          setPersistedRevision(result.updatedAt);
          void queryClient.invalidateQueries({
            queryKey: designQueryKey(value.designId),
            exact: true,
          });
        },
        save: ({
          designId: targetDesignId,
          settings: nextSettings,
        }: DesignSettingsPersistence) =>
          updateDesignSettings(targetDesignId, nextSettings),
      }),
    [queryClient],
  );
  const artworkProcessingMutation = useMutation({
    mutationFn: ({
      designId: targetDesignId,
      image,
      challengeToken,
    }: ArtworkProcessingMutation) => {
      return processDesignArtwork(targetDesignId, image, challengeToken).catch(
        (error: unknown) => {
          const diagnostics = settingsErrorDiagnostics(error);
          console.error("[bent.shop design] print artwork save failed", {
            code: diagnostics.code,
            designId: targetDesignId,
            ...safeErrorDetails(error),
            requestId: diagnostics.requestId,
            status: diagnostics.status,
          });
          throw error;
        },
      );
    },
    onSuccess: (response, variables) => {
      if (variables.processingId !== processingIdRef.current) return;
      setArtworkReady(true);
      setActiveArtworkJobId(response.artworkJobId);
      setDecodedArtworkJobId(undefined);
      setPersistedRevision(response.updatedAt);
      void queryClient.invalidateQueries({
        queryKey: artworkPreviewQueryKey(variables.designId),
      });
      void queryClient.invalidateQueries({
        queryKey: designQueryKey(variables.designId),
        exact: true,
      });
    },
    // The client owns bounded conflict recovery; an outer retry can replay a consumed proof.
    retry: false,
    scope: { id: "design-artwork" },
  });
  const productPreparationMutation = useMutation({
    mutationFn: (input: CreateConfiguredProductFamilyRequest) => {
      return createConfiguredProductFamily(input).catch((error: unknown) => {
        console.error("[bent.shop product] preparation failed", {
          designId: input.designId,
          ...safeErrorDetails(error),
        });
        throw error;
      });
    },
    retry: retryServerMutation,
    retryDelay: serverMutationRetryDelay,
    scope: { id: "product-preparation" },
  });
  const persistArtwork = artworkProcessingMutation.mutateAsync;
  const artworkProcessingFailed = artworkProcessingMutation.isError;
  const resetArtworkProcessing = artworkProcessingMutation.reset;
  const prepareProduct = productPreparationMutation.mutateAsync;
  const productPreparationPending = productPreparationMutation.isPending;
  const productPreparationFailed = productPreparationMutation.isError;
  const resetProductPreparation = productPreparationMutation.reset;
  const handleCutoutRevealComplete = useCallback(() => {
    setProcessingState("ready");
    const attemptId = creationAttemptIdRef.current;
    if (attemptId && designId) {
      reportCreationTrace({
        attemptId,
        designId,
        durationMs: Math.round(
          performance.now() - creationStartedAtRef.current,
        ),
        stage: "cutout_reveal_completed",
      });
    }
    if (processedCutoutUrlRef.current.startsWith("blob:")) {
      URL.revokeObjectURL(processedCutoutUrlRef.current);
    }
    processedCutoutUrlRef.current = "";
    setProcessedCutoutUrl("");
    if (capturedPhotoUrlRef.current.startsWith("blob:")) {
      URL.revokeObjectURL(capturedPhotoUrlRef.current);
    }
    capturedPhotoUrlRef.current = "";
    setCapturedPhotoUrl("");
  }, [designId]);
  const handleCutoutRevealCovered = useCallback(() => {
    setRevealCovered(true);
  }, []);

  useEffect(() => {
    sourceRef.current = source;
  }, [source]);

  useLayoutEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useLayoutEffect(() => {
    settingsSchedulerRef.current?.cancel();
    const interaction = directManipulationRef.current;
    const metrics = interaction && gestureMetrics(interaction.pointers);
    if (interaction && metrics) {
      directManipulationRef.current = {
        ...interaction,
        startMetrics: metrics,
        startSettings: settingsRef.current,
      };
    }
  }, [cropZoomLimit]);

  useEffect(() => {
    if (
      !designId ||
      !activeArtworkJobId ||
      initialDesign.artworkJobId !== activeArtworkJobId ||
      initialDesign.status !== "ready" ||
      processingState !== "ready" ||
      changingBackground ||
      dragging ||
      !source ||
      decodedArtworkJobId === activeArtworkJobId
    )
      return;
    let cancelled = false;
    const processingId = processingIdRef.current;
    const kind = settings.removeBackground === false ? "original" : "cutout";
    artworkSourcesRef.current.clear();
    async function replacePreview(targetId: string, jobId: string) {
      try {
        const blob = await getArtworkSourcePreview(targetId, kind);
        const bitmap = await createImageBitmap(blob);
        if (cancelled || processingId !== processingIdRef.current) {
          bitmap.close();
          return;
        }
        artworkSourcesRef.current.set(kind, blob);
        sourceRef.current?.close();
        sourceRef.current = bitmap;
        setSource(bitmap);
        setDecodedArtworkJobId(jobId);
        setFinalPreviewError("");
      } catch {
        if (!cancelled)
          setFinalPreviewError(
            "The finished photo could not be loaded. Please try again.",
          );
      }
    }
    void replacePreview(designId, activeArtworkJobId);
    return () => {
      cancelled = true;
    };
  }, [
    activeArtworkJobId,
    changingBackground,
    decodedArtworkJobId,
    designId,
    dragging,
    finalPreviewAttempt,
    initialDesign?.artworkJobId,
    initialDesign?.status,
    processingState,
    settings.removeBackground,
    source,
  ]);

  useEffect(() => {
    if (hasPendingPrintFile) return;
    if (!resolvedArtworkReady || !readyDesignSettings) return;
    if (sourceRef.current) return;
    const designSettings = readyDesignSettings;
    const artwork = initialArtworkQuery.data;
    if (!artwork) return;
    let cancelled = false;

    async function loadInitialDesign(artworkBlob: Blob) {
      let nextSource: ImageBitmap;
      try {
        nextSource = await createImageBitmap(artworkBlob);
      } catch {
        setProcessingState("error");
        return;
      }
      if (cancelled) {
        nextSource.close();
        return;
      }
      artworkSourcesRef.current.set(
        designSettings.removeBackground === false ? "original" : "cutout",
        artworkBlob,
      );
      sourceRef.current?.close();
      sourceRef.current = nextSource;
      setSource(nextSource);
      setSettings(designSettings);
      setPersistedSettings(designSettings);
      setProcessingState("ready");
    }

    void loadInitialDesign(artwork);
    return () => {
      cancelled = true;
    };
  }, [
    hasPendingPrintFile,
    initialArtworkQuery.data,
    readyDesignSettings,
    resolvedArtworkReady,
  ]);

  useEffect(() => {
    if (!designId || !source || persistedSettings === settings) {
      return;
    }

    const saveTimer = window.setTimeout(() => {
      settingsPersistence.submit({ designId, settings });
    }, 180);

    return () => {
      window.clearTimeout(saveTimer);
    };
  }, [designId, persistedSettings, settingsPersistence, settings, source]);

  useLayoutEffect(() => {
    return () => {
      if (challengeRequestRef.current) {
        processingIdRef.current += 1;
        cancelArtworkChallenge();
      }
      // Cache Components hides recent routes with React Activity. Effect cleanup
      // runs while the component state (including this ImageBitmap) is preserved,
      // so explicitly detaching it here would break Back navigation. Replaced
      // bitmaps are still closed at the point of replacement above.
      cameraStreamRef.current?.getTracks().forEach((track) => {
        track.stop();
      });
      cameraRequestIdRef.current += 1;
      cameraSwitchingRef.current = false;
      uploadRequestIdRef.current += 1;
      setPreparingUpload(false);
      cameraCaptureIdRef.current += 1;
      cameraStreamRef.current = undefined;
      openedDraftCameraRef.current = false;
      setCameraStream(undefined);
      setMultipleCameras(false);
      setCameraReady(false);
      setCameraCountdown(undefined);
      if (processedCutoutUrlRef.current.startsWith("blob:")) {
        URL.revokeObjectURL(processedCutoutUrlRef.current);
      }
      if (capturedPhotoUrlRef.current.startsWith("blob:")) {
        URL.revokeObjectURL(capturedPhotoUrlRef.current);
      }
      if (activeLayerTimeoutRef.current !== undefined) {
        window.clearTimeout(activeLayerTimeoutRef.current);
      }
      settingsSchedulerRef.current?.cancel();
    };
  }, [cancelArtworkChallenge]);

  useEffect(() => {
    const video = cameraVideoRef.current;
    if (video && cameraStream) video.srcObject = cameraStream;
  }, [cameraStream]);

  useEffect(() => {
    if (!cameraStream) return;
    let cancelled = false;
    let discoveryId = 0;
    const refresh = async () => {
      const id = ++discoveryId;
      const multiple = await hasMultipleCameras();
      if (!cancelled && id === discoveryId) setMultipleCameras(multiple);
    };
    void refresh();
    const onDeviceChange = () => {
      void refresh();
    };
    navigator.mediaDevices.addEventListener("devicechange", onDeviceChange);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener(
        "devicechange",
        onDeviceChange,
      );
    };
  }, [cameraStream]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const minimapCanvas = minimapCanvasRef.current;
    const toteMinimapCanvas = toteMinimapCanvasRef.current;
    if (!source) return;
    if (canvas) renderRecursiveImage(canvas, source, settings);
    if (minimapCanvas) {
      renderRecursiveImage(
        minimapCanvas,
        source,
        projectedEditorSettings(settings, "staple-tee"),
      );
    }
    if (toteMinimapCanvas) {
      renderRecursiveImage(
        toteMinimapCanvas,
        source,
        projectedEditorSettings(settings, "cotton-tote"),
      );
    }
  }, [cameraStream, settings, source, reviewingPhoto, revealCovered]);

  async function loadPersistedArtwork(
    targetDesignId: string,
    revision: string,
    preview?: Blob,
    processingId = processingIdRef.current,
  ) {
    const previewStartedAt = performance.now();
    const attemptId = creationAttemptIdRef.current;
    let processedImage: Blob;
    try {
      processedImage =
        preview ?? (await getArtworkPreview(targetDesignId, revision));
    } catch {
      if (processingId === processingIdRef.current) setProcessingState("error");
      return;
    }
    if (processingId !== processingIdRef.current) return;

    const decodeStartedAt = performance.now();
    if (attemptId) {
      reportCreationTrace({
        attemptId,
        designId: targetDesignId,
        durationMs: Math.round(decodeStartedAt - previewStartedAt),
        stage: "artwork_preview_loaded",
      });
    }

    let nextSource: ImageBitmap;
    try {
      nextSource = await createImageBitmap(processedImage);
    } catch {
      if (processingId === processingIdRef.current) setProcessingState("error");
      return;
    }
    if (processingId !== processingIdRef.current) {
      nextSource.close();
      return;
    }

    artworkSourcesRef.current.set("cutout", processedImage);
    setHasOriginalArtwork(true);
    const nextSettings = {
      ...suggestSettings(nextSource),
      removeBackground: true,
    };
    sourceRef.current?.close();
    sourceRef.current = nextSource;
    setSource(nextSource);
    setSettings(nextSettings);

    const nextProcessedCutoutUrl = URL.createObjectURL(processedImage);
    processedCutoutUrlRef.current = nextProcessedCutoutUrl;
    setProcessedCutoutUrl(nextProcessedCutoutUrl);
    cutoutPreparationDurationRef.current = Math.round(
      performance.now() - decodeStartedAt,
    );
    setProcessingState("revealing");
  }

  async function processFile(printFile: File) {
    const targetDesignId = designId;
    if (
      !targetDesignId ||
      !printFile.type.startsWith("image/") ||
      printFile.size > MAX_DESIGN_SOURCE_BYTES
    ) {
      setProcessingState("error");
      return;
    }

    cancelArtworkChallenge();
    artworkSourcesRef.current.clear();
    setActiveArtworkJobId(undefined);
    setDecodedArtworkJobId(undefined);
    setFinalPreviewError("");
    setChangingBackground(false);
    setPendingBackgroundRemoval(undefined);
    setBackgroundError("");
    setHasOriginalArtwork(false);
    setDragging(false);
    const processingId = processingIdRef.current + 1;
    processingIdRef.current = processingId;
    const attemptId = crypto.randomUUID();
    creationAttemptIdRef.current = attemptId;
    const startedAt = performance.now();
    creationStartedAtRef.current = startedAt;
    reportCreationTrace({
      attemptId,
      designId: targetDesignId,
      stage: "artwork_upload_started",
    });
    if (capturedPhotoUrlRef.current.startsWith("blob:")) {
      URL.revokeObjectURL(capturedPhotoUrlRef.current);
    }
    const nextCapturedPhotoUrl = URL.createObjectURL(printFile);
    capturedPhotoUrlRef.current = nextCapturedPhotoUrl;
    setCapturedPhotoUrl(nextCapturedPhotoUrl);
    if (processedCutoutUrlRef.current.startsWith("blob:")) {
      URL.revokeObjectURL(processedCutoutUrlRef.current);
      processedCutoutUrlRef.current = "";
      setProcessedCutoutUrl("");
    }
    setRevealCovered(false);
    settingsSchedulerRef.current?.cancel();
    directManipulationRef.current = undefined;
    sourceRef.current?.close();
    sourceRef.current = undefined;
    setSource(undefined);
    setPersistedSettings(undefined);
    setPreparedProduct(undefined);
    setArtworkReady(false);
    pendingPrintFileRef.current = printFile;
    setHasPendingPrintFile(true);
    resetArtworkProcessing();
    resetProductPreparation();
    setProcessingState("processing");
    let response: Awaited<ReturnType<typeof processDesignArtwork>>;
    try {
      // A replacement upload reserves the draft version. Finish earlier
      // placement saves before requesting that reservation.
      await settingsPersistence.settle();
      if (processingId !== processingIdRef.current) return;
      setSettingsSaveFailed(false);
      let challengeToken: string | undefined;
      if (needsArtworkChallengeRef.current) {
        const request = Promise.withResolvers<string>();
        challengeRequestRef.current = request;
        setArtworkChallenge(request);
        const timeout = window.setTimeout(() => {
          if (challengeRequestRef.current === request) cancelArtworkChallenge();
        }, 180_000);
        try {
          challengeToken = await request.promise;
        } finally {
          window.clearTimeout(timeout);
          if (challengeRequestRef.current === request) {
            challengeRequestRef.current = undefined;
            setArtworkChallenge(undefined);
          }
        }
        if (processingId !== processingIdRef.current) return;
      }
      response = await persistArtwork({
        challengeToken,
        designId: targetDesignId,
        image: printFile,
        processingId,
      });
    } catch (error) {
      if (processingId !== processingIdRef.current) return;
      const diagnostics = settingsErrorDiagnostics(error);
      if (
        diagnostics.status === 403 &&
        diagnostics.code === "CHALLENGE_REQUIRED"
      ) {
        needsArtworkChallengeRef.current = true;
      }
      reportCreationTrace({
        attemptId,
        code: diagnostics.code,
        designId: targetDesignId,
        durationMs: Math.round(performance.now() - startedAt),
        requestId: diagnostics.requestId,
        retryAfterSeconds: diagnostics.retryAfterSeconds,
        stage: "artwork_upload_failed",
        status: diagnostics.status,
      });
      setProcessingState("error");
      return;
    }
    if (processingId !== processingIdRef.current) return;
    needsArtworkChallengeRef.current = false;
    reportCreationTrace({
      attemptId,
      designId: targetDesignId,
      durationMs: response.diagnostics.durationMs,
      grantDurationMs: response.diagnostics.grantDurationMs,
      uploadResponseDurationMs: response.diagnostics.uploadResponseDurationMs,
      responseDownloadDurationMs:
        response.diagnostics.responseDownloadDurationMs,
      uploadBodyDurationMs: response.diagnostics.uploadBodyDurationMs,
      portraitDurationMs: response.diagnostics.portraitDurationMs,
      previewBytes: response.diagnostics.previewBytes,
      networkSetupDurationMs: response.diagnostics.networkSetupDurationMs,
      networkRequestDurationMs: response.diagnostics.networkRequestDurationMs,
      workerDurationMs: response.diagnostics.workerDurationMs,
      screeningDurationMs: response.diagnostics.screeningDurationMs,
      previewDurationMs: response.diagnostics.previewDurationMs,
      uploadBytes: printFile.size,
      requestId: response.diagnostics.requestId,
      stage: "artwork_upload_succeeded",
    });
    await loadPersistedArtwork(
      targetDesignId,
      response.updatedAt,
      response.preview,
      processingId,
    );
  }

  const openCamera = useCallback(
    async (requestedFacing?: CameraFacing) => {
      if (!window.isSecureContext) {
        setProcessingState("error");
        return;
      }

      const requestId = ++cameraRequestIdRef.current;
      const previousStream = cameraStreamRef.current;
      const previousSettings = previousStream
        ?.getVideoTracks()[0]
        ?.getSettings();
      const previousFacing = cameraFacingRef.current;
      // Phones may only allow one camera at a time, so release before switching.
      cameraStreamRef.current = undefined;
      previousStream?.getTracks().forEach((track) => {
        track.stop();
      });
      setCameraReady(false);
      setCameraError("");
      let pendingStream: MediaStream | undefined;
      const adoptStream = async (
        stream: MediaStream,
        fallbackFacing: CameraFacing,
      ) => {
        if (requestId !== cameraRequestIdRef.current) return;
        const track = stream.getVideoTracks()[0];
        if (track) await requestMaximumCameraResolution(track);
        if (requestId !== cameraRequestIdRef.current) return;
        const facing = track?.getSettings().facingMode;
        const selectedFacing =
          facing === "user" || facing === "environment"
            ? facing
            : fallbackFacing;
        cameraFacingRef.current = selectedFacing;
        setCameraFacing(selectedFacing);
        cameraStreamRef.current = stream;
        setCameraStream(stream);
        pendingStream = undefined;
      };
      try {
        const facing = requestedFacing ?? previousFacing;
        pendingStream =
          (!requestedFacing && designId
            ? takeCameraForDraft(designId)
            : undefined) ??
          (await requestCameraStream({
            facingMode: requestedFacing ? { exact: facing } : { ideal: facing },
            width: { ideal: IDEAL_CAMERA_WIDTH_PX },
          }));
        if (requestedFacing) {
          const selected = pendingStream.getVideoTracks()[0]?.getSettings();
          if (
            (selected?.facingMode && selected.facingMode !== requestedFacing) ||
            (selected?.deviceId &&
              selected.deviceId === previousSettings?.deviceId)
          ) {
            throw new Error("The requested camera is unavailable.");
          }
        }
        await adoptStream(pendingStream, facing);
      } catch {
        pendingStream?.getTracks().forEach((track) => {
          track.stop();
        });
        pendingStream = undefined;
        if (requestId !== cameraRequestIdRef.current) return;
        try {
          if (!requestedFacing || !previousStream)
            throw new Error("No camera to restore.");
          pendingStream = await requestCameraStream({
            ...(previousSettings?.deviceId
              ? { deviceId: { exact: previousSettings.deviceId } }
              : { facingMode: { exact: previousFacing } }),
            width: { ideal: IDEAL_CAMERA_WIDTH_PX },
          });
          await adoptStream(pendingStream, previousFacing);
          if (requestId === cameraRequestIdRef.current) {
            setCameraError(
              "Could not switch cameras. Your previous camera is ready. Try again.",
            );
          }
        } catch {
          if (requestId === cameraRequestIdRef.current) {
            setCameraStream(undefined);
            setProcessingState("error");
          }
        }
      } finally {
        pendingStream?.getTracks().forEach((track) => {
          track.stop();
        });
      }
    },
    [designId],
  );

  async function flipCamera() {
    if (
      !cameraReady ||
      cameraCountdown !== undefined ||
      cameraSwitchingRef.current
    )
      return;
    cameraSwitchingRef.current = true;
    const requestId = cameraRequestIdRef.current + 1;
    try {
      await openCamera(
        cameraFacingRef.current === "user" ? "environment" : "user",
      );
    } finally {
      if (requestId === cameraRequestIdRef.current)
        cameraSwitchingRef.current = false;
    }
  }

  const startUploadedPhoto = useEffectEvent((file: File) => {
    setReviewingPhoto(true);
    setSkipProcessingLoader(false);
    void processFile(file);
  });

  useEffect(() => {
    if (
      initialDesign?.status !== "creating" ||
      initialDesign.previewReady === true ||
      openedDraftCameraRef.current
    ) {
      return;
    }
    // Defer acquisition until this mount survives effect cleanup. This also
    // keeps React Strict Mode from consuming and stopping a transferred stream.
    const timer = window.setTimeout(() => {
      openedDraftCameraRef.current = true;
      if (uploadLaunch) {
        const file = designId ? takeImageForDraft(designId) : undefined;
        if (file) startUploadedPhoto(file);
        else if (!pendingPrintFileRef.current && !sourceRef.current)
          setProcessingState("error");
      } else {
        void openCamera();
      }
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [
    designId,
    initialDesign?.status,
    initialDesign?.previewReady,
    openCamera,
    uploadLaunch,
  ]);

  async function selectUploadedPhoto(file: File) {
    const requestId = ++uploadRequestIdRef.current;
    setPreparingUpload(true);
    setUploadError("");
    try {
      const prepared = await prepareImageUpload(file);
      if (requestId !== uploadRequestIdRef.current) return;
      setReviewingPhoto(true);
      setSkipProcessingLoader(false);
      void processFile(prepared);
    } catch (error) {
      if (requestId !== uploadRequestIdRef.current) return;
      setUploadError(
        error instanceof Error
          ? error.message
          : "This image could not be opened. Choose another image.",
      );
    } finally {
      if (requestId === uploadRequestIdRef.current) setPreparingUpload(false);
    }
  }

  function closeCamera() {
    discardCameraHandoff();
    cameraRequestIdRef.current += 1;
    cameraSwitchingRef.current = false;
    cameraCaptureIdRef.current += 1;
    cameraStreamRef.current?.getTracks().forEach((track) => {
      track.stop();
    });
    cameraStreamRef.current = undefined;
    setCameraStream(undefined);
    setMultipleCameras(false);
    setCameraReady(false);
    setCameraCountdown(undefined);
  }

  async function captureCameraPhoto() {
    const video = cameraVideoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) return;
    const captureId = cameraCaptureIdRef.current;

    try {
      const printFrame = await captureVideoFrame(
        video,
        MAXIMUM_PRINT_CAPTURE_EDGE_PX,
        PRINT_CAPTURE_JPEG_QUALITY,
        MAX_DESIGN_SOURCE_BYTES,
        cameraFacingRef.current === "user",
      );
      if (captureId !== cameraCaptureIdRef.current) return;
      closeCamera();
      setReviewingPhoto(true);
      setSkipProcessingLoader(false);
      await processFile(
        new File([printFrame.blob], "camera-photo-print.jpg", {
          type: "image/jpeg",
        }),
      );
    } catch {
      if (captureId !== cameraCaptureIdRef.current) return;
      closeCamera();
      setProcessingState("error");
    }
  }

  async function startCameraCountdown() {
    if (!cameraReady || cameraCountdown !== undefined) return;

    const captureId = cameraCaptureIdRef.current + 1;
    cameraCaptureIdRef.current = captureId;

    for (let seconds = cameraTimer; seconds > 0; seconds -= 1) {
      setCameraCountdown(seconds);
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 1_000);
      });
      if (captureId !== cameraCaptureIdRef.current) return;
    }

    await captureCameraPhoto();
  }

  function retakePreview() {
    // Uploads remain serialized for draft-version ordering. Ignore all results
    // from this photo as soon as the customer discards it, including decoding.
    processingIdRef.current += 1;
    cancelArtworkChallenge();
    setReviewingPhoto(false);
    setSkipProcessingLoader(false);
    setProcessingState("empty");
    setArtworkReady(false);
    settingsSchedulerRef.current?.cancel();
    sourceRef.current?.close();
    sourceRef.current = undefined;
    setSource(undefined);
    pendingPrintFileRef.current = undefined;
    setHasPendingPrintFile(false);
    resetArtworkProcessing();
    for (const url of [
      capturedPhotoUrlRef.current,
      processedCutoutUrlRef.current,
    ]) {
      if (url.startsWith("blob:")) URL.revokeObjectURL(url);
    }
    capturedPhotoUrlRef.current = "";
    processedCutoutUrlRef.current = "";
    setCapturedPhotoUrl("");
    setProcessedCutoutUrl("");
    void openCamera();
  }

  function confirmPhoto() {
    setSkipProcessingLoader(processingState === "revealing");
    setReviewingPhoto(false);
  }

  async function toggleBackgroundRemoval(removeBackground: boolean) {
    if (!designId || changingBackground || !hasOriginalArtwork) return;
    flushSettings();
    setChangingBackground(true);
    setPendingBackgroundRemoval(removeBackground);
    setBackgroundError("");
    const processingId = processingIdRef.current;
    const kind = removeBackground ? "cutout" : "original";
    try {
      const blob =
        artworkSourcesRef.current.get(kind) ??
        (await getArtworkSourcePreview(designId, kind));
      const nextSource = await createImageBitmap(blob);
      if (processingId !== processingIdRef.current) {
        nextSource.close();
        return;
      }
      artworkSourcesRef.current.set(kind, blob);
      sourceRef.current?.close();
      sourceRef.current = nextSource;
      setSource(nextSource);
      const nextSettings = { ...settingsRef.current, removeBackground };
      settingsRef.current = nextSettings;
      setSettings(nextSettings);
    } catch {
      if (processingId === processingIdRef.current)
        setBackgroundError("The photo could not be loaded. Please try again.");
    } finally {
      if (processingId === processingIdRef.current) {
        setChangingBackground(false);
        setPendingBackgroundRemoval(undefined);
      }
    }
  }

  function toggleRecursivePattern(enabled: boolean) {
    flushSettings();
    const current = settingsRef.current;
    if (current.depth > 0) recursiveDepthRef.current = current.depth;
    const nextSettings = {
      ...current,
      depth: enabled ? recursiveDepthRef.current : 0,
    };
    settingsRef.current = nextSettings;
    setSettings(nextSettings);
    setActiveLayer(undefined);
  }

  function beginDirectManipulation(event: PointerEvent<HTMLDivElement>) {
    const existing = directManipulationRef.current;
    if (existing && existing.pointers.size >= 2) return;

    const bounds = event.currentTarget.getBoundingClientRect();
    const current = settingsRef.current;
    const pointerX = (event.clientX - bounds.left) / bounds.width;
    const pointerY = (event.clientY - bounds.top) / bounds.height;
    const layer =
      existing?.layer ?? editingLayerAtPoint(current, pointerX, pointerY);
    const pointers = existing?.pointers ?? new Map<number, PointerPosition>();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const metrics = gestureMetrics(pointers);
    if (!metrics) return;

    if (activeLayerTimeoutRef.current !== undefined) {
      window.clearTimeout(activeLayerTimeoutRef.current);
      activeLayerTimeoutRef.current = undefined;
    }
    setActiveLayer(layer);
    event.currentTarget.setPointerCapture(event.pointerId);
    directManipulationRef.current = {
      layer,
      pointers,
      startMetrics: metrics,
      startSettings: current,
    };
  }

  function moveDirectManipulation(event: PointerEvent<HTMLDivElement>) {
    const interaction = directManipulationRef.current;
    if (
      !interaction ||
      !interaction.pointers.has(event.pointerId) ||
      !event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      return;
    }

    setDragging(true);
    interaction.pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    const metrics = gestureMetrics(interaction.pointers);
    if (!metrics) return;

    const bounds = event.currentTarget.getBoundingClientRect();
    scheduleSettings(
      applyDirectManipulation(
        interaction.layer,
        interaction.startSettings,
        interaction.startMetrics,
        metrics,
        bounds.width,
        bounds.height,
        cropZoomLimit,
      ),
    );
  }

  function endDirectManipulation(event: PointerEvent<HTMLDivElement>) {
    const interaction = directManipulationRef.current;
    if (!interaction?.pointers.has(event.pointerId)) return;

    flushSettings();

    interaction.pointers.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const metrics = gestureMetrics(interaction.pointers);
    if (metrics) {
      directManipulationRef.current = {
        ...interaction,
        startMetrics: metrics,
        startSettings: settingsRef.current,
      };
      return;
    }

    directManipulationRef.current = undefined;
    setDragging(false);
    activeLayerTimeoutRef.current = window.setTimeout(() => {
      setActiveLayer(undefined);
      activeLayerTimeoutRef.current = undefined;
    }, 700);
  }

  async function retryFinishedArtwork() {
    if (!designId || !activeArtworkJobId) return;
    if (!progressiveFailed) {
      setFinalPreviewAttempt((value) => value + 1);
      return;
    }
    setRetryingArtwork(true);
    try {
      await retryArtworkPreparation(designId, activeArtworkJobId);
      setFinalPreviewError("");
      await queryClient.invalidateQueries({
        queryKey: designQueryKey(designId),
        exact: true,
      });
    } catch (error) {
      setFinalPreviewError(errorMessage(error));
    } finally {
      setRetryingArtwork(false);
    }
  }

  async function prepareConfiguredProduct() {
    if (
      !designId ||
      productPreparationPending ||
      continuationPending ||
      navigationPending ||
      printQualityUnavailable ||
      printQualityPending ||
      sourceTooSmall
    ) {
      return;
    }

    flushSettings();
    setContinuationPending(true);
    onContinuationChange?.(true);
    try {
      // Finalization is expected during Continue. Stop draft polling before it
      // can compete with navigation, retaining the canvas until the route commits.
      await queryClient.cancelQueries({
        queryKey: designQueryKey(designId),
        exact: true,
      });
      const nextDesignId = designId;
      const finalSettings = settingsRef.current;
      const finalSource = sourceRef.current;
      await settingsPersistence.flush({
        designId: nextDesignId,
        settings: finalSettings,
      });
      if (configuredProductId) {
        startNavigation(() => {
          void navigate({
            to: productPath(configuredProductId),
            replace: true,
          });
        });
        return;
      }
      const configuredProducts = await prepareProduct({
        baseProductIds: LAUNCH_BASE_PRODUCTS.map((target) => target.id),
        designId: nextDesignId,
      });
      const configuredProduct = configuredProducts[0];
      // Only reuse the source submitted for this revision. A gesture or source
      // switch during the request must fall back to the authoritative recipe.
      if (
        finalSource &&
        finalSource === sourceRef.current &&
        finalSettings === settingsRef.current
      ) {
        for (const product of configuredProducts) {
          const slug = LAUNCH_BASE_PRODUCTS.find(
            (base) => base.id === product.baseProductId,
          )?.slug;
          const placement = product.placement;
          const revision = product.designRevisionId ?? product.preparationId;
          if (!slug || !revision || !placement) continue;
          retainProductPreview(
            product.id,
            {
              revision,
              baseProductSlug: slug,
              settings: {
                ...finalSettings,
                depth:
                  product.printMode === "base-image-only" ? 0 : placement.depth,
                placementX: placement.x,
                placementY: placement.y,
                placementWidth: placement.width,
              },
            },
            finalSource,
          );
        }
      }
      if (!configuredProduct) {
        throw new Error("Neither product projection could be prepared.");
      }
      setPreparedProduct({
        designId: nextDesignId,
        productId: configuredProduct.id,
      });
      void queryClient.invalidateQueries({
        queryKey: designQueryKey(nextDesignId),
        exact: true,
        refetchType: "none",
      });
      void queryClient.invalidateQueries({ queryKey: ["saved-designs"] });
      const nextProductPath = productPath(configuredProduct.id);
      startNavigation(() => {
        void navigate({ to: nextProductPath, replace: true });
      });
    } catch {
      onContinuationChange?.(false);
      // The mutation and persistence callbacks own customer-facing retry state.
    } finally {
      setContinuationPending(false);
    }
  }

  function continueToProduct() {
    void prepareConfiguredProduct();
  }

  function retryPurchasePreparation() {
    if (artworkProcessingFailed) {
      const printFile = pendingPrintFileRef.current;
      if (designId && printFile) {
        void processFile(printFile);
      }
      return;
    }
    if ((settingsSaveFailed || productPreparationFailed) && designId) {
      resetProductPreparation();
      void prepareConfiguredProduct();
    }
  }

  function retryDesignProcessing() {
    const printFile = pendingPrintFileRef.current;
    if (!designId || !printFile) {
      if (uploadLaunch) uploadInputRef.current?.click();
      else void openCamera();
      return;
    }
    setProcessingState("processing");
    if (artworkReady && persistedRevision) {
      void loadPersistedArtwork(designId, persistedRevision);
      return;
    }
    void processFile(printFile);
  }

  const hasSource = source !== undefined;
  const artworkProcessingDiagnostics = settingsErrorDiagnostics(
    artworkProcessingMutation.error,
  );
  const showError =
    (processingState === "error" || initialArtworkQuery.isError) && !hasSource;
  const showInitialArtworkError =
    initialDesign?.status === "ready" && !hasPendingPrintFile && showError;
  const showProcessingLoader = processingState === "processing";
  const showInitialArtworkSkeleton =
    initialDesign?.status === "ready" &&
    !hasSource &&
    processingState !== "error" &&
    !initialArtworkQuery.isError;
  const keepLoaderBehindReveal =
    processingState === "revealing" && !revealCovered;
  const showFullscreenProcessing =
    !reviewingPhoto &&
    !skipProcessingLoader &&
    !cameraStream &&
    capturedPhotoUrl.length > 0 &&
    (showProcessingLoader || keepLoaderBehindReveal);
  const showFullscreenReveal =
    !reviewingPhoto &&
    processingState === "revealing" &&
    processedCutoutUrl.length > 0;
  useEffect(() => {
    const attemptId = creationAttemptIdRef.current;
    if (!showFullscreenReveal || !attemptId || !designId) return;
    reportCreationTrace({
      attemptId,
      designId,
      durationMs: cutoutPreparationDurationRef.current,
      stage: "cutout_reveal_started",
    });
  }, [designId, showFullscreenReveal]);
  const showPhotoPreview =
    reviewingPhoto || (skipProcessingLoader && keepLoaderBehindReveal);
  const viewportLocked =
    showPhotoPreview || showFullscreenProcessing || showFullscreenReveal;
  useViewportScrollLock(viewportLocked);
  const configuredProductId =
    preparedProduct && preparedProduct.designId === designId
      ? preparedProduct.productId
      : undefined;
  const canContinue =
    designId !== undefined &&
    source !== undefined &&
    !changingBackground &&
    !printQualityUnavailable &&
    !printQualityPending &&
    !sourceTooSmall &&
    settings.cropZoom <= cropZoomLimit &&
    !continuationPending &&
    !navigationPending &&
    !settingsSaveFailed &&
    !productPreparationPending &&
    !productPreparationFailed &&
    baseProductAvailability !== "checking";
  const canRetryEditor =
    !canContinue &&
    !printQualityUnavailable &&
    !printQualityPending &&
    !sourceTooSmall &&
    !continuationPending &&
    !navigationPending &&
    !productPreparationPending &&
    (artworkProcessingFailed || settingsSaveFailed || productPreparationFailed);
  const editorSubmissionPending =
    continuationPending || productPreparationPending || navigationPending;
  return (
    <main
      className={cn(
        "relative bg-background text-primary",
        "min-h-dvh overflow-x-hidden transition-colors duration-500",
      )}
    >
      <div className="pointer-events-none absolute inset-0 z-[1] bg-[linear-gradient(90deg,transparent_49.8%,color-mix(in_srgb,var(--blue)_9%,transparent)_50%,transparent_50.2%)] bg-[length:2rem_100%]" />
      <input
        ref={uploadInputRef}
        className="hidden"
        type="file"
        accept={IMAGE_UPLOAD_ACCEPT}
        aria-label="Choose image"
        disabled={preparingUpload}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void selectUploadedPhoto(file);
        }}
      />
      {artworkChallenge ? (
        <div className="absolute inset-0 z-50 bg-background/80">
          <TurnstileChallenge onToken={acceptArtworkChallenge} />
        </div>
      ) : null}
      {uploadError ? (
        <p
          role="alert"
          className="absolute inset-x-0 top-12 z-30 bg-background px-5 py-3 text-xs leading-5"
        >
          {uploadError}
        </p>
      ) : null}

      {showPhotoPreview ? (
        <section
          aria-label="Photo preview"
          className="relative z-20 h-dvh w-full overflow-hidden bg-background pt-12"
        >
          <div className="relative h-full w-full">
            <img
              data-fill="true"
              loading="eager"
              src={capturedPhotoUrl}
              alt={uploadLaunch ? "Your uploaded photo" : "Your captured photo"}
              sizes="100vw"
              className="object-contain"
            />
          </div>
          {reviewingPhoto ? (
            <div className="absolute right-4 bottom-[max(1.5rem,env(safe-area-inset-bottom))] left-4 flex justify-between gap-4">
              <Button
                variant="ghost"
                className="h-auto min-h-11 rounded-none border border-primary bg-background px-4 py-3 font-mono text-[0.72rem] font-bold tracking-[0.06em] text-primary uppercase hover:bg-primary hover:text-primary-foreground"
                disabled={preparingUpload}
                onClick={
                  uploadLaunch
                    ? () => uploadInputRef.current?.click()
                    : retakePreview
                }
              >
                {uploadLaunch
                  ? preparingUpload
                    ? "Preparing…"
                    : "Choose another"
                  : "Retake"}
              </Button>
              <Button
                data-confirm-photo=""
                className="h-auto min-h-11 rounded-none border border-primary bg-primary px-4 py-3 font-mono text-[0.72rem] font-bold tracking-[0.06em] text-primary-foreground uppercase hover:bg-background hover:text-primary"
                onClick={confirmPhoto}
                disabled={preparingUpload}
              >
                Confirm
              </Button>
            </div>
          ) : null}
        </section>
      ) : cameraStream ? (
        <div className="relative z-20 h-dvh w-full overflow-hidden bg-background pt-12 text-foreground">
          <video
            ref={cameraVideoRef}
            autoPlay
            muted
            playsInline
            aria-hidden="true"
            className={cn(
              "size-full object-contain",
              cameraFacing === "user" && "-scale-x-100",
              cameraReady ? "visible" : "invisible",
            )}
            onLoadedMetadata={() => {
              if (cameraVideoRef.current?.srcObject === cameraStreamRef.current)
                setCameraReady(true);
            }}
          />

          {!cameraReady ? (
            <div className="absolute inset-0 grid place-items-center bg-background">
              <CameraPreparingIndicator
                label={uploadLaunch ? "Preparing image" : "Preparing camera"}
              />
            </div>
          ) : cameraCountdown !== undefined ? (
            <div className="pointer-events-none absolute inset-0 grid place-items-center bg-background/10 text-[9rem] leading-none font-black text-foreground tabular-nums">
              {cameraCountdown}
            </div>
          ) : null}

          {cameraReady ? (
            <Button
              variant="ghost"
              className="absolute top-16 left-4 z-20 h-11 min-w-11 gap-1.5 rounded-none border border-primary bg-background px-2.5 font-mono text-xs text-primary hover:bg-primary hover:text-primary-foreground"
              disabled={cameraCountdown !== undefined}
              aria-label={`Photo timer: ${String(cameraTimer)} seconds. Change timer`}
              onClick={() => {
                setCameraTimer((seconds) =>
                  seconds === 3 ? 5 : seconds === 5 ? 10 : 3,
                );
              }}
            >
              <TimerIcon aria-hidden="true" className="size-4" />
              <span className="normal-case">{cameraTimer}s</span>
            </Button>
          ) : null}

          {multipleCameras ? (
            <Button
              variant="ghost"
              className={cn(
                "absolute right-4 z-20 size-11 rounded-none border border-primary bg-background p-0 text-primary hover:bg-primary hover:text-primary-foreground",
                source ? "top-32" : "top-16",
              )}
              disabled={!cameraReady || cameraCountdown !== undefined}
              aria-label="Flip camera"
              title="Flip camera"
              onClick={() => void flipCamera()}
            >
              <SwitchCameraIcon aria-hidden="true" className="size-5" />
            </Button>
          ) : null}
          {cameraError ? (
            <p
              role="alert"
              className="absolute inset-x-4 bottom-24 z-20 border border-primary bg-background p-3 text-xs text-primary"
            >
              {cameraError}
            </p>
          ) : null}

          {cameraReady && source ? (
            <Button
              variant="ghost"
              className="absolute top-16 right-4 z-20 h-auto min-h-11 w-auto rounded-none border border-primary bg-background px-4 py-3 font-mono text-[0.72rem] font-bold tracking-[0.06em] text-primary uppercase hover:bg-primary hover:text-primary-foreground"
              aria-label="Cancel retake"
              onClick={closeCamera}
            >
              Cancel
            </Button>
          ) : null}
          {cameraReady ? (
            <Button
              className="absolute bottom-[max(1.5rem,env(safe-area-inset-bottom))] left-1/2 z-20 h-auto min-h-11 w-auto -translate-x-1/2 rounded-none border border-primary bg-primary px-4 py-3 font-mono text-[0.72rem] font-bold tracking-[0.06em] text-primary-foreground uppercase hover:bg-background hover:text-primary"
              disabled={cameraCountdown !== undefined}
              aria-label={`Take photo in ${String(cameraTimer)} seconds`}
              onClick={() => void startCameraCountdown()}
            >
              Take photo
            </Button>
          ) : null}
        </div>
      ) : hasSource ? (
        <section className="relative z-10 flex min-h-dvh flex-col items-center justify-center gap-4 px-4 py-16">
          <div className="relative aspect-[5/6] w-[min(100%,calc(70dvh*5/6))]">
            <div className="aspect-[5/6] w-full overflow-hidden border border-primary bg-background">
              <div
                aria-disabled={editorSubmissionPending}
                className={cn(
                  "relative size-full touch-none overflow-hidden bg-background",
                  editorSubmissionPending && "cursor-wait",
                )}
                inert={editorSubmissionPending ? true : undefined}
                onPointerDown={
                  editorSubmissionPending ? undefined : beginDirectManipulation
                }
                onPointerMove={
                  editorSubmissionPending ? undefined : moveDirectManipulation
                }
                onPointerUp={
                  editorSubmissionPending ? undefined : endDirectManipulation
                }
                onLostPointerCapture={endDirectManipulation}
                onPointerCancel={
                  editorSubmissionPending ? undefined : endDirectManipulation
                }
              >
                <canvas
                  ref={canvasRef}
                  width={PREVIEW_WIDTH}
                  height={PREVIEW_HEIGHT}
                  className={cn(
                    "block size-full",
                    processingState === "ready" &&
                      "editor-direct-manipulation-cue",
                    editorSubmissionPending
                      ? "cursor-wait"
                      : "cursor-grab active:cursor-grabbing",
                  )}
                />
                <EditorMinimap
                  defaultColor={defaultColor}
                  dragging={dragging}
                  canvasRef={minimapCanvasRef}
                  toteCanvasRef={toteMinimapCanvasRef}
                />
                <div
                  className={cn(
                    "pointer-events-none absolute inset-[0.35rem] border border-dotted border-transparent transition-colors duration-150",
                    activeLayer === "crop" && "border-primary",
                  )}
                  aria-hidden="true"
                />
                <div
                  className={cn(
                    "pointer-events-none absolute border border-dotted border-transparent transition-colors duration-150",
                    activeLayer === "placement" && "border-primary",
                  )}
                  style={{
                    left: `${String(settings.placementX * 100)}%`,
                    top: `${String(settings.placementY * 100)}%`,
                    width: `${String(settings.placementWidth * 100)}%`,
                    height: `${String(settings.placementWidth * 100)}%`,
                  }}
                  aria-hidden="true"
                />
              </div>
            </div>

            <Button
              size="lg"
              variant="ghost"
              className="absolute bottom-4 left-4 z-20 h-auto min-h-11 w-auto rounded-none border border-primary bg-background px-4 py-3 font-mono text-[0.72rem] font-bold tracking-[0.06em] text-primary uppercase hover:bg-primary hover:text-primary-foreground disabled:opacity-45"
              aria-label={
                uploadLaunch ? "Upload another image" : "Take another photo"
              }
              disabled={editorSubmissionPending || preparingUpload}
              onClick={() => {
                if (uploadLaunch) uploadInputRef.current?.click();
                else void openCamera();
              }}
            >
              {uploadLaunch
                ? preparingUpload
                  ? "Preparing…"
                  : "Choose another"
                : "Retake"}
            </Button>
            <Button
              size="lg"
              className="absolute right-4 bottom-4 z-20 h-auto min-h-11 w-auto rounded-none border border-primary bg-primary px-4 py-3 font-mono text-[0.72rem] font-bold tracking-[0.06em] text-primary-foreground uppercase hover:bg-background hover:text-primary disabled:opacity-45"
              aria-busy={
                continuationPending ||
                productPreparationPending ||
                navigationPending
              }
              disabled={preparingUpload || (!canContinue && !canRetryEditor)}
              onClick={
                canContinue ? continueToProduct : retryPurchasePreparation
              }
            >
              {navigationPending
                ? "Opening…"
                : continuationPending || productPreparationPending
                  ? "Preparing…"
                  : canRetryEditor
                    ? "Try again"
                    : "Continue"}
            </Button>
          </div>
          <fieldset
            className="relative flex w-[min(100%,calc(70dvh*5/6))] flex-wrap gap-x-4 bg-background px-3"
            disabled={editorSubmissionPending || changingBackground}
            aria-label="Design options"
          >
            <label className="flex min-h-11 cursor-pointer items-center gap-2 font-mono text-[0.65rem] font-bold uppercase">
              <span className="relative flex">
                <input
                  type="checkbox"
                  checked={
                    !(
                      pendingBackgroundRemoval ??
                      settings.removeBackground ??
                      true
                    )
                  }
                  disabled={!hasOriginalArtwork}
                  onChange={(event) =>
                    void toggleBackgroundRemoval(!event.target.checked)
                  }
                  className="peer size-4 appearance-none border border-primary checked:bg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-45"
                />
                <CheckIcon
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 hidden size-4 text-white peer-checked:block"
                />
              </span>
              Background
            </label>
            <label className="flex min-h-11 cursor-pointer items-center gap-2 font-mono text-[0.65rem] font-bold uppercase">
              <span className="relative flex">
                <input
                  type="checkbox"
                  checked={settings.depth > 0}
                  onChange={(event) => {
                    toggleRecursivePattern(event.target.checked);
                  }}
                  className="peer size-4 appearance-none border border-primary checked:bg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                />
                <CheckIcon
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 hidden size-4 text-white peer-checked:block"
                />
              </span>
              Effect
            </label>
            <p
              role={
                backgroundError || productPreparationFailed ? "alert" : "status"
              }
              className="absolute top-full left-3 pt-1 text-xs"
            >
              {backgroundError ||
                (productPreparationFailed
                  ? errorMessage(productPreparationMutation.error)
                  : changingBackground
                    ? "Updating photo…"
                    : "")}
            </p>
          </fieldset>
          {activeArtworkJobId ? (
            <div
              className="min-h-4 max-w-sm text-xs"
              role={progressiveFailed || finalPreviewError ? "alert" : "status"}
            >
              <p>
                {finalArtworkPending
                  ? finalPreviewError ||
                    (progressiveFailed
                      ? "Photo preparation failed. Your edits are saved."
                      : "Preparing print-quality photo…")
                  : ""}
              </p>
              {finalArtworkPending &&
              (progressiveFailed || finalPreviewError) ? (
                <Button
                  variant="ghost"
                  disabled={retryingArtwork}
                  onClick={() => {
                    void retryFinishedArtwork();
                  }}
                >
                  Try again
                </Button>
              ) : null}
            </div>
          ) : null}
          {!finalArtworkPending &&
          (sourceTooSmall || printQualityUnavailable) ? (
            <p role="status" className="max-w-sm text-xs">
              {sourceTooSmall
                ? "Use a higher-resolution photo to continue."
                : "Checking print quality…"}
            </p>
          ) : null}
          {!hasOriginalArtwork ? (
            <p className="max-w-sm text-xs">
              Take or upload another photo to restore its background.
            </p>
          ) : null}
          {baseProductAvailability !== undefined &&
          baseProductAvailability !== "available" ? (
            <div
              className="w-[min(100%,calc(70dvh*5/6))] border border-primary bg-background p-4 text-sm leading-6"
              role={baseProductAvailability === "checking" ? "status" : "alert"}
            >
              <p>
                {baseProductAvailability === "checking"
                  ? "Checking product availability…"
                  : "T-shirt checkout is unavailable right now. You can still preview both products."}
              </p>
              {baseProductAvailability === "unavailable" &&
              onRetryProductAvailability ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="mt-3 min-h-11 rounded-none border border-primary px-4 font-mono text-xs font-bold tracking-[0.06em] uppercase"
                  onClick={onRetryProductAvailability}
                >
                  Check again
                </Button>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : showInitialArtworkError ? (
        <InitialArtworkError
          retrying={initialArtworkQuery.isFetching}
          onRetry={() => {
            setProcessingState("empty");
            void initialArtworkQuery.refetch();
          }}
        />
      ) : showError && hasPendingPrintFile ? (
        <DesignProcessingError
          reference={artworkProcessingDiagnostics.requestId}
          onRetry={retryDesignProcessing}
        />
      ) : showError ? (
        uploadLaunch ? (
          <section className="relative z-10 grid min-h-dvh place-content-center gap-4 px-5 text-center">
            <p className="text-sm">Choose an image to continue creating.</p>
            <Button
              className="min-h-12 rounded-none font-mono"
              disabled={preparingUpload}
              onClick={() => uploadInputRef.current?.click()}
            >
              {preparingUpload ? "Preparing…" : "Upload image"}
            </Button>
          </section>
        ) : (
          <CameraUnavailable onRetry={() => void openCamera()} />
        )
      ) : showFullscreenProcessing ? (
        <section className="min-h-dvh bg-primary" aria-hidden="true" />
      ) : initialDesign?.status === "creating" ? (
        <section className="relative z-10 grid min-h-dvh place-items-center px-5 pt-12">
          <CameraPreparingIndicator
            label={uploadLaunch ? "Preparing image" : "Preparing camera"}
          />
        </section>
      ) : showInitialArtworkSkeleton ? (
        <InitialArtworkSkeleton />
      ) : (
        <DesignPageSkeleton />
      )}

      {showFullscreenProcessing ? (
        <ProcessingPiercingLoader
          ariaLabel="Removing the background from your photo"
          imageUrl={capturedPhotoUrl}
        />
      ) : null}

      {showFullscreenReveal ? (
        <ProcessedCutoutReveal
          imageUrl={processedCutoutUrl}
          onCovered={handleCutoutRevealCovered}
          onComplete={handleCutoutRevealComplete}
        />
      ) : null}
    </main>
  );
}

function CameraUnavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <section className="relative z-10 grid min-h-dvh place-items-center px-5 pt-12 text-center">
      <div className="grid max-w-64 justify-items-center gap-4">
        <p className="text-sm leading-6" role="alert">
          Camera access is needed to take your photo.
        </p>
        <Button
          className="min-h-11 rounded-none border border-primary bg-primary px-4 py-3 font-mono text-[0.72rem] font-bold tracking-[0.06em] text-primary-foreground uppercase hover:bg-background hover:text-primary"
          onClick={onRetry}
        >
          Try again
        </Button>
      </div>
    </section>
  );
}

function DesignProcessingError({
  onRetry,
  reference,
}: {
  onRetry: () => void;
  reference: string | undefined;
}) {
  return (
    <section className="relative z-10 grid min-h-dvh place-items-center px-5 pt-12 text-center">
      <div className="grid max-w-72 justify-items-center gap-4">
        <p className="text-sm leading-6" role="alert">
          We couldn&apos;t prepare your artwork. Your photo is still on this
          device, so you can try again without retaking it.
        </p>
        {reference ? (
          <p className="font-mono text-[0.68rem] tracking-[0.04em]">
            Reference: {reference}
          </p>
        ) : null}
        <Button
          className="min-h-11 rounded-none border border-primary bg-primary px-4 py-3 font-mono text-[0.72rem] font-bold tracking-[0.06em] text-primary-foreground uppercase hover:bg-background hover:text-primary"
          onClick={onRetry}
        >
          Try again
        </Button>
      </div>
    </section>
  );
}

function InitialArtworkError({
  onRetry,
  retrying,
}: {
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <section className="relative z-10 grid min-h-dvh place-items-center px-5 py-16 text-center">
      <div className="w-[min(100%,32rem)]">
        <p className="text-xs tracking-[0.08em]">Design saved</p>
        <h1 className="mt-3 text-4xl leading-tight font-bold tracking-[-0.04em]">
          We couldn&apos;t load your artwork.
        </h1>
        <p className="mx-auto mt-4 max-w-[28rem] text-sm leading-6">
          Your design hasn&apos;t been changed. Check your connection and try
          loading it again.
        </p>
        <Button
          type="button"
          className="mt-8 min-h-14 rounded-none border border-primary bg-primary px-[1.4rem] py-4 font-mono text-[0.72rem] font-bold tracking-[0.06em] text-primary-foreground uppercase hover:bg-background hover:text-primary"
          disabled={retrying}
          onClick={onRetry}
        >
          {retrying ? "Loading…" : "Try again"}
        </Button>
      </div>
    </section>
  );
}

function InitialArtworkSkeleton() {
  return (
    <section
      className="relative z-10 flex min-h-dvh flex-col items-center justify-center gap-4 px-4 py-16"
      role="status"
      aria-label="Loading your artwork"
    >
      <div className="relative aspect-[5/6] w-[min(100%,calc(70dvh*5/6))]">
        <div
          className={cn(
            "aspect-[5/6] w-full overflow-hidden border border-dotted border-primary",
            "animate-pulse bg-surface motion-reduce:animate-none",
          )}
          data-skeleton-block
          aria-hidden="true"
        />
      </div>
      <span className="sr-only">Loading your artwork…</span>
    </section>
  );
}

async function captureVideoFrame(
  video: HTMLVideoElement,
  maximumEdge: number,
  quality: number,
  maximumBytes: number,
  mirror: boolean,
): Promise<CapturedFrame> {
  if (
    Math.max(video.videoWidth, video.videoHeight) > maximumEdge ||
    video.videoWidth * video.videoHeight > MAX_DESIGN_SOURCE_PIXELS
  ) {
    throw new Error("The camera image exceeds the supported resolution.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Camera rendering is not available.");
    if (mirror) {
      context.translate(canvas.width, 0);
      context.scale(-1, 1);
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    for (const nextQuality of [quality, 0.9, 0.85]) {
      const blob = await canvasToBlob(canvas, {
        type: "image/jpeg",
        quality: nextQuality,
      });
      if (blob.size <= maximumBytes)
        return { blob, height: canvas.height, width: canvas.width };
    }
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }

  throw new Error(
    "The camera image could not be prepared within the upload limit.",
  );
}

async function requestMaximumCameraResolution(track: MediaStreamTrack) {
  const capabilities = track.getCapabilities();
  const maximumWidth = capabilities.width?.max;
  const maximumHeight = capabilities.height?.max;
  if (maximumWidth === undefined || maximumHeight === undefined) return;

  try {
    await track.applyConstraints({
      height: { ideal: maximumHeight },
      width: { ideal: maximumWidth },
    });
  } catch (error) {
    console.info("[bent.shop camera] maximum resolution unavailable", {
      error: error instanceof Error ? error.message : String(error),
      requested: { height: maximumHeight, width: maximumWidth },
    });
  }
}
