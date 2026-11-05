"use client";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

import { retainCameraForDraft } from "@/client/camera-handoff";
import { retainImageForDraft } from "@/client/image-handoff";
import { createDesign } from "@/client/design-api";
import { reportCreationTrace } from "@/client/creation-trace";
import { CameraPreparingPage } from "@/components/camera-preparing";
import { TurnstileChallenge } from "@/components/turnstile-challenge";
import { Button } from "@/components/ui/button";

const CAMERA_REQUEST_TIMEOUT_MS = 10_000;
const DESIGN_CREATE_TIMEOUT_MS = 10_000;

interface DraftRequest {
  readonly activationId: number;
  readonly controller: AbortController;
  complete: boolean;
  timeout: number;
}

interface ChallengeToken {
  readonly activationId: number;
  readonly value: string;
}

export function CameraPermissionLauncher({
  onDraftCreated,
  image,
}: {
  onDraftCreated: (designId: string) => void;
  image?: File;
}) {
  const openCreatedDraft = useEffectEvent(onDraftCreated);
  const cameraStreamRef = useRef<MediaStream | undefined>(undefined);
  const activationIdRef = useRef(0);
  const requestIdRef = useRef(0);
  const draftRequestRef = useRef<DraftRequest | undefined>(undefined);
  const [failure, setFailure] = useState<"camera" | "rate-limit" | "security">();
  const [cameraGrantActivationId, setCameraGrantActivationId] = useState<number>();
  const [challengeAttempt, setChallengeAttempt] = useState(0);
  const [challengeToken, setChallengeToken] = useState<ChallengeToken>();

  const acceptChallengeToken = useCallback((token: string | undefined) => {
    setChallengeToken(token
      ? { activationId: activationIdRef.current, value: token }
      : undefined);
  }, []);

  const requestCamera = useCallback(async () => {
    const activationId = activationIdRef.current;
    if (image) {
      setCameraGrantActivationId(activationId);
      return;
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    let stream: MediaStream | undefined;
    try {
      if (!window.isSecureContext) {
        throw new Error("Camera access is unavailable.");
      }
      stream = await getCameraStream();
      if (requestId !== requestIdRef.current) return;
      cameraStreamRef.current?.getTracks().forEach(track => { track.stop(); });
      cameraStreamRef.current = stream;
      stream = undefined;

      setCameraGrantActivationId(activationId);
    } catch {
      if (requestId === requestIdRef.current) setFailure("camera");
    } finally {
      stream?.getTracks().forEach((track) => {
        track.stop();
      });
    }
  }, [image]);

  useEffect(() => {
    activationIdRef.current += 1;
    const startTimer = window.setTimeout(() => {
      void requestCamera();
    }, 0);
    return () => {
      window.clearTimeout(startTimer);
      cameraStreamRef.current?.getTracks().forEach(track => { track.stop(); });
      cameraStreamRef.current = undefined;
      activationIdRef.current += 1;
      requestIdRef.current += 1;
      const draftRequest = draftRequestRef.current;
      if (draftRequest) {
        draftRequest.complete = true;
        window.clearTimeout(draftRequest.timeout);
        draftRequest.controller.abort();
        draftRequestRef.current = undefined;
      }
    };
  }, [requestCamera]);

  useEffect(() => {
    if (cameraGrantActivationId === undefined) return;
    const releaseUnusedCamera = () => {
      cameraStreamRef.current?.getTracks().forEach(track => { track.stop(); });
      cameraStreamRef.current = undefined;
    };
    const releaseWhenHidden = () => {
      if (document.visibilityState === "hidden") releaseUnusedCamera();
    };
    // A slow challenge must not retain an invisible camera indefinitely. The
    // editor can acquire a fresh stream if this short handoff window expires.
    const timeout = window.setTimeout(releaseUnusedCamera, 15_000);
    window.addEventListener("pagehide", releaseUnusedCamera);
    document.addEventListener("visibilitychange", releaseWhenHidden);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("pagehide", releaseUnusedCamera);
      document.removeEventListener("visibilitychange", releaseWhenHidden);
    };
  }, [cameraGrantActivationId]);

  useEffect(() => {
    const activationId = activationIdRef.current;
    if (
      cameraGrantActivationId !== activationId ||
      challengeToken?.activationId !== activationId
    ) return;
    if (draftRequestRef.current) return;
    const controller = new AbortController();
    const attemptId = crypto.randomUUID();
    const request: DraftRequest = {
      activationId,
      complete: false,
      controller,
      timeout: 0,
    };
    draftRequestRef.current = request;
    const fail = (error?: unknown) => {
      if (
        request.complete || draftRequestRef.current !== request ||
        request.activationId !== activationIdRef.current
      ) return;
      request.complete = true;
      draftRequestRef.current = undefined;
      cameraStreamRef.current?.getTracks().forEach(track => { track.stop(); });
      cameraStreamRef.current = undefined;
      setChallengeToken(undefined);
      setChallengeAttempt((attempt) => attempt + 1);
      setCameraGrantActivationId(undefined);
      setFailure(isRateLimitedDesignError(error) ? "rate-limit" : "security");
    };
    request.timeout = window.setTimeout(() => {
      controller.abort();
      fail();
    }, DESIGN_CREATE_TIMEOUT_MS);

    void createDesign(challengeToken.value, controller.signal).then((design) => {
      if (
        !request.complete && draftRequestRef.current === request &&
        request.activationId === activationIdRef.current
      ) {
        request.complete = true;
        reportCreationTrace({
          attemptId,
          designId: design.id,
          durationMs: design.diagnostics.durationMs,
          requestId: design.diagnostics.requestId,
          stage: "draft_handoff_started",
        });
        const stream = cameraStreamRef.current;
        if (image) retainImageForDraft(design.id, image);
        if (stream) retainCameraForDraft(design.id, stream);
        cameraStreamRef.current = undefined;
        openCreatedDraft(design.id);
      }
    }).catch((error: unknown) => {
      fail(error);
    }).finally(() => {
      window.clearTimeout(request.timeout);
    });
  }, [cameraGrantActivationId, challengeToken, image]);

  if (!failure) {
    return (
      <CameraPreparingPage label={image ? "Preparing image" : "Preparing camera"}>
        <TurnstileChallenge key={challengeAttempt} onToken={acceptChallengeToken} />
      </CameraPreparingPage>
    );
  }

  return (
    <main className="grid flex-1 place-items-center bg-background px-5 pt-12 text-primary">
      <div className="grid max-w-64 justify-items-center gap-4 text-center">
        <p className="text-sm leading-6" role="alert">
          {failure === "camera"
            ? "Camera access is needed to take your photo."
            : failure === "rate-limit"
              ? "You've reached the photo limit. Please try again later."
              : "The security check could not be completed. Please try again."}
        </p>
        <Button
          className="min-h-11 rounded-none border border-primary bg-primary px-4 py-3 font-mono text-[0.72rem] font-bold tracking-[0.06em] text-primary-foreground uppercase hover:bg-background hover:text-primary"
          onClick={() => {
            setFailure(undefined);
            if (failure === "security") {
              setChallengeAttempt((attempt) => attempt + 1);
            }
            setCameraGrantActivationId(undefined);
            void requestCamera();
          }}
        >
          Try again
        </Button>
      </div>
    </main>
  );
}

function isRateLimitedDesignError(error: unknown) {
  return typeof error === "object" && error !== null &&
    "status" in error && error.status === 429;
}

async function getCameraStream() {
  let timedOut = false;
  let timeout: number | undefined;
  const cameraRequest = navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: "user", width: { ideal: 3840 } },
  });
  const timeoutRequest = new Promise<never>((_resolve, reject) => {
    timeout = window.setTimeout(() => {
      timedOut = true;
      reject(new Error("The camera request took too long."));
    }, CAMERA_REQUEST_TIMEOUT_MS);
  });

  void cameraRequest.then((lateStream) => {
    if (!timedOut) return;
    lateStream.getTracks().forEach((track) => {
      track.stop();
    });
  }, () => undefined);

  try {
    return await Promise.race([cameraRequest, timeoutRequest]);
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
  }
}
