"use client";

import { useEffect, useRef, useState } from "react";

import { loadTurnstile } from "@/client/turnstile-api";
import { usePublicConfig } from "@/public-config";

interface TurnstileChallengeProps {
  readonly onToken: (token: string | undefined) => void;
}

export function TurnstileChallenge({ onToken }: TurnstileChallengeProps) {
  const config = usePublicConfig();
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string>(undefined);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [status, setStatus] = useState<
    "loading" | "ready" | "error" | "expired" | "script-error"
  >("loading");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let active = true;
    void loadTurnstile()
      .then((turnstile) => {
        if (!active || widgetIdRef.current) return;
        widgetIdRef.current = turnstile.render(container, {
          action: "design_processing",
          appearance: "interaction-only",
          callback: (token) => {
            setStatus("ready");
            onToken(token);
          },
          "error-callback": () => {
            setStatus("error");
            onToken(undefined);
          },
          "expired-callback": () => {
            setStatus("expired");
            onToken(undefined);
          },
          sitekey: config.turnstileSiteKey,
          theme: "auto",
        });
        setStatus("ready");
      })
      .catch(() => {
        if (active) setStatus("script-error");
      });
    return () => {
      active = false;
      const widgetId = widgetIdRef.current;
      if (widgetId) window.turnstile?.remove(widgetId);
      widgetIdRef.current = undefined;
    };
  }, [config.turnstileSiteKey, loadAttempt, onToken]);

  const retry = () => {
    onToken(undefined);
    const turnstile = window.turnstile;
    const widgetId = widgetIdRef.current;
    if (turnstile && widgetId) {
      turnstile.reset(widgetId);
      setStatus("ready");
      return;
    }
    setStatus("loading");
    setLoadAttempt((attempt) => attempt + 1);
  };

  const failureMessage =
    status === "expired"
      ? "The security check expired. Please try it again."
      : status === "script-error"
        ? "The security check could not load. Check your connection and retry."
        : status === "error"
          ? "The security check failed. Please try it again."
          : undefined;

  return (
    <>
      {failureMessage ? (
        <div
          className="absolute inset-0 z-10 grid place-items-center bg-background px-5 text-center"
          role="alert"
        >
          <div className="grid justify-items-center gap-3">
            <p className="text-sm leading-6">{failureMessage}</p>
            <button
              className="min-h-11 border border-primary px-4 font-mono text-xs font-bold uppercase"
              type="button"
              onClick={retry}
            >
              Retry security check
            </button>
          </div>
        </div>
      ) : null}
      <div
        ref={containerRef}
        className="absolute top-1/2 left-1/2 z-10 -translate-x-1/2 -translate-y-1/2"
        aria-label="Security check"
        aria-busy={status === "loading"}
      />
    </>
  );
}
