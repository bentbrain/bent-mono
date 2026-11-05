"use client";

import { CheckIcon, LinkIcon } from "lucide-react";
import { useEffect, useState } from "react";

const shareButtonClassName =
  "grid size-14 shrink-0 place-items-center border border-primary bg-background text-primary hover:bg-primary hover:text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary max-[900px]:size-12";

export function currentProductUrl() {
  return window.location.href;
}

export function ProductShare() {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (copyStatus === "idle") return;
    const timeout = window.setTimeout(() => {
      setCopyStatus("idle");
    }, 1_600);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [copyStatus]);

  async function copyLink() {
    const productUrl = currentProductUrl();
    try {
      await navigator.clipboard.writeText(productUrl);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  return (
    <div className="relative shrink-0">
      <button
        aria-label={copyStatus === "copied" ? "Product link copied" : "Copy product link"}
        data-product-action="share"
        className={shareButtonClassName}
        type="button"
        onClick={() => {
          void copyLink();
        }}
      >
        {copyStatus === "copied" ? (
          <CheckIcon
            aria-hidden="true"
            className="size-5"
            data-copy-icon="check"
            strokeWidth={2}
          />
        ) : (
          <LinkIcon
            aria-hidden="true"
            className="size-5"
            data-copy-icon="link"
            strokeWidth={2}
          />
        )}
      </button>

      {copyStatus === "copied" ? (
        <span
          className="absolute bottom-[calc(100%+0.4rem)] left-1/2 z-20 -translate-x-1/2 border border-dotted border-primary bg-white px-2 py-1 text-[0.65rem] font-bold text-primary"
          role="status"
        >
          Copied
        </span>
      ) : null}
      {copyStatus === "failed" ? (
        <span
          className="absolute bottom-[calc(100%+0.4rem)] left-0 z-20 w-max border border-dotted border-primary bg-white px-2 py-1 text-[0.65rem] font-bold text-primary"
          role="alert"
        >
          Couldn&apos;t copy
        </span>
      ) : null}
    </div>
  );
}
