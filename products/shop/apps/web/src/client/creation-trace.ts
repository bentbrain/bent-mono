type CreationTraceStage =
  | "draft_handoff_started"
  | "artwork_upload_started"
  | "artwork_upload_succeeded"
  | "artwork_upload_failed"
  | "artwork_preview_loaded"
  | "cutout_reveal_started"
  | "cutout_reveal_completed";

export interface CreationTraceEvent {
  readonly attemptId: string;
  readonly code?: string | undefined;
  readonly designId: string;
  readonly durationMs?: number | undefined;
  readonly grantDurationMs?: number | undefined;
  readonly uploadResponseDurationMs?: number | undefined;
  readonly responseDownloadDurationMs?: number | undefined;
  readonly uploadBodyDurationMs?: number | undefined;
  readonly portraitDurationMs?: number | undefined;
  readonly previewBytes?: number | undefined;
  readonly networkSetupDurationMs?: number | undefined;
  readonly networkRequestDurationMs?: number | undefined;
  readonly workerDurationMs?: number | undefined;
  readonly screeningDurationMs?: number | undefined;
  readonly previewDurationMs?: number | undefined;
  readonly uploadBytes?: number | undefined;
  readonly requestId?: string | undefined;
  readonly retryAfterSeconds?: number | undefined;
  readonly stage: CreationTraceStage;
  readonly status?: number | undefined;
}

export function reportCreationTrace(event: CreationTraceEvent) {
  try {
    void fetch("/api/creation-trace", {
    body: JSON.stringify(event),
    headers: { "content-type": "application/json" },
    keepalive: true,
    method: "POST",
    }).catch(() => undefined);
  } catch {
    // A synchronous transport failure must not interrupt creation either.
  }
}
