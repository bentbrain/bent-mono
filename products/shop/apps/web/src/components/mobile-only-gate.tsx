"use client";

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

const DESKTOP_QUERY = "(min-width: 1024px)";

type Viewport = "desktop" | "mobile" | "server";

interface MobileOnlyGateProps {
  children: ReactNode;
  draftHandoff?: boolean;
  renderMobileFallback?: boolean;
}

function subscribeToViewport(onChange: () => void) {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener("change", onChange);
  return () => {
    query.removeEventListener("change", onChange);
  };
}

function getViewport(): Viewport {
  return window.matchMedia(DESKTOP_QUERY).matches ? "desktop" : "mobile";
}

function getServerFallbackViewport(): Viewport {
  return "server";
}

export function MobileOnlyGate({
  children,
  draftHandoff = false,
  renderMobileFallback = false,
}: MobileOnlyGateProps) {
  const viewport = useSyncExternalStore(
    subscribeToViewport,
    getViewport,
    renderMobileFallback
      ? getServerFallbackViewport
      : getServerDesktopViewport,
  );

  if (viewport === "desktop") {
    return draftHandoff ? <DesktopDraftGuidance /> : <DesktopQrHandoff />;
  }

  return (
    <>
      {/* Preserve the form and in-flight mobile work when hydration resolves. */}
      <div className={viewport === "mobile" ? "contents" : "flex flex-1 lg:hidden"}>{children}</div>
      {viewport === "server" && (draftHandoff ? <DesktopDraftGuidance /> : <DesktopQrHandoff />)}
    </>
  );
}

function getServerDesktopViewport(): Viewport {
  return "desktop";
}

function DesktopQrHandoff() {
  const qrCanvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = qrCanvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    void import("qrcode").then(({ default: QRCode }) => {
      if (cancelled) return;
      return QRCode.toCanvas(canvas, window.location.href, {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 256,
        color: {
          dark: "#0647ff",
          light: "#ffffff",
        },
      });
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="relative z-10 hidden flex-1 place-items-center bg-background p-8 text-primary lg:grid">
      <canvas
        ref={qrCanvasRef}
        className="block h-auto w-[min(68vw,256px)] border border-primary"
        role="img"
        aria-label="QR code to continue creating this design on a phone"
      />
    </main>
  );
}

function DesktopDraftGuidance() {
  return (
    <main className="relative z-10 hidden flex-1 place-items-center bg-background p-8 text-primary lg:grid">
      <div className="w-[min(100%,34rem)] text-center">
        <p className="mb-4 text-[0.68rem] font-bold tracking-[0.1em]">
          Draft saved on your original phone
        </p>
        <h1 className="text-[clamp(2.8rem,6vw,5.5rem)] leading-[0.9] font-[650] tracking-[-0.07em]">
          Continue on your original phone
        </h1>
        <p className="mx-auto mt-6 max-w-[29rem] text-sm leading-[1.6]">
          Reopen this draft in the browser on the phone where you started.
        </p>
      </div>
    </main>
  );
}
