"use client";

import Image from "next/image";

interface ProcessingPiercingLoaderProps {
  ariaLabel?: string;
  imageUrl: string;
  noiseOpacity?: number;
}

export function ProcessingPiercingLoader({
  ariaLabel = "Processing captured portrait",
  imageUrl,
  noiseOpacity = 0.5,
}: ProcessingPiercingLoaderProps) {
  return (
    <div
      className="fixed inset-0 z-40 isolate grid h-dvh w-dvw touch-none place-items-center overflow-hidden overscroll-none bg-primary"
      role="status"
      aria-label={ariaLabel}
      aria-live="polite"
    >
      <Image
        fill
        unoptimized
        loading="eager"
        src={imageUrl}
        alt=""
        sizes="100vw"
        className="-z-30 scale-[1.08] object-cover object-center blur-[18px] grayscale contrast-[2.4] brightness-125"
      />
      <div
        className="absolute inset-0 -z-20 bg-primary/85 mix-blend-screen"
        aria-hidden="true"
      />
      <div
        className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_center,transparent_0%,color-mix(in_srgb,var(--blue)_22%,transparent)_72%,color-mix(in_srgb,var(--blue)_48%,transparent)_100%)]"
        aria-hidden="true"
      />
      <div
        className="monochrome-noise pointer-events-none absolute -inset-1/4 z-[-5]"
        style={{ opacity: noiseOpacity }}
        aria-hidden="true"
      />
      <PaletteInversionSpinner imageUrl={imageUrl} />
    </div>
  );
}

function PaletteInversionSpinner({ imageUrl }: { imageUrl: string }) {
  return (
    <span
      className="palette-spinner relative size-11 rounded-full"
      aria-hidden="true"
    >
      <span className="palette-spinner-ring absolute inset-0">
        <span className="absolute top-1/2 left-1/2 isolate h-dvh w-dvw -translate-x-1/2 -translate-y-1/2">
          <Image
            fill
            unoptimized
            loading="eager"
            src={imageUrl}
            alt=""
            sizes="100vw"
            className="-z-20 scale-[1.08] object-cover object-center blur-[18px] grayscale contrast-[12] brightness-125 invert"
          />
          <span className="absolute inset-0 -z-10 bg-primary mix-blend-screen" />
        </span>
      </span>
    </span>
  );
}
