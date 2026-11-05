"use client";

import { previewFrameKey, retainPreviewFrame } from "@/client/product-preview-frame";
import { BrowserProductPreview } from "@/components/browser-product-preview";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useProductMediaWarmup } from "@/components/product-family";
import {
  productProjectionSpecification,
  type BaseProductSlug,
} from "@forever-tee/contracts/product-projection";
import { preload as preloadResource } from "react-dom";

import { productImagePath, productImageSrcSet } from "@/lib/product-image";
import { cn } from "@/lib/utils";

interface MockupProps {
  ariaLabel: string;
  baseProductSlug: BaseProductSlug;
  className?: string;
  color: string;
  designId: string;
  preload?: boolean;
  preloadAlternateColors?: boolean;
  productId?: string;
  revision: string;
  sizes: string;
}

export function ComposedGarmentMockup(props: MockupProps) {
  const { warm } = useProductMediaWarmup();
  // Keep decoded images and browser canvases alive for this product/revision.
  // Switching colour changes visibility, not the image source or its lifecycle.
  return <div className="relative aspect-square w-full">
    {productProjectionSpecification(props.baseProductSlug).colors.map(color => {
      const canonicalPath = productImagePath({ ...props, color });
      const selected = color.toLowerCase() === props.color.toLowerCase();
      const ariaLabel = props.ariaLabel.startsWith(`${props.color} `)
        ? `${color}${props.ariaLabel.slice(props.color.length)}` : props.ariaLabel;
      return <div key={`${canonicalPath}/${props.revision}`} hidden={!selected} data-variant-active={selected}>
        <ProductImage {...props} color={color} ariaLabel={ariaLabel} canonicalPath={canonicalPath}
          preload={Boolean(props.preload && selected && !warm)} preloadAlternateColors={false} />
      </div>;
    })}
  </div>;
}

const ProductImage = memo(function ProductImage({
  canonicalPath,
  ariaLabel,
  baseProductSlug,
  className,
  color,
  designId,
  preload = false,
  preloadAlternateColors = false,
  productId,
  revision,
  sizes,
}: MockupProps & { canonicalPath: string }) {
  const { warm, imageReady } = useProductMediaWarmup();
  const imageRef = useRef<HTMLImageElement>(null);
  const [browserReady,setBrowserReady]=useState(false);
  const [accessDenied,setAccessDenied]=useState(false);
  const previewReady=useCallback(()=>{setBrowserReady(true);if(preload)imageReady();},[preload,imageReady]);
  const [attempt, setAttempt] = useState(0);
  const [cycle, setCycle] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "slow" | "failed">("loading");
  const controller = useRef<AbortController | undefined>(undefined);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const deadlineTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const checking = useRef(false);
  const pendingPolls = useRef(0);
  const settled = useRef(false);
  const finish = useCallback((next: "ready" | "failed") => {
    clearTimeout(retryTimer.current);
    clearTimeout(deadlineTimer.current);
    controller.current?.abort();
    checking.current = false;
    settled.current = true;
    setStatus(next);
    const image = imageRef.current;
    if (next === "ready" && productId && image && image.naturalWidth > 0) {
      retainPreviewFrame(previewFrameKey(productId, revision, color), image, image.naturalWidth, image.naturalHeight);
    }

    if (preload) imageReady();
  }, [preload, imageReady, productId, revision, color]);

  const checkReadiness = useCallback(async function check(): Promise<void> {
    if (checking.current || settled.current) return;
    clearTimeout(retryTimer.current);
    checking.current = true;
    const request = new AbortController();
    controller.current = request;
    try {
      const response = await fetch(canonicalPath, { method: "HEAD", cache: "no-store", signal: request.signal });
      if (request.signal.aborted) return;
      if (response.status === 200) {
        setAttempt(value => value + 1);
      } else if ([400, 401, 403, 404, 410, 422].includes(response.status)) {
        if(response.status !== 410)setAccessDenied(true);
        finish("failed");
      } else {
        retryTimer.current = setTimeout(() => { void check(); }, pendingPolls.current++ < 10 ? 500 : 2_000);
      }
    } catch {
      if (!request.signal.aborted) {
        retryTimer.current = setTimeout(() => { void check(); }, pendingPolls.current++ < 10 ? 500 : 2_000);
      }
    } finally {
      if (controller.current === request) checking.current = false;
    }
  }, [canonicalPath, finish]);

  useEffect(() => {
    if ((!preload && !warm) || settled.current) return;
    if (imageRef.current?.complete && imageRef.current.naturalWidth > 0) {
      finish("ready");
      return;
    }
    if (imageRef.current?.complete) void checkReadiness();
    deadlineTimer.current = setTimeout(() => {
      setStatus("slow");
      void checkReadiness();
    }, 15_000);
    return () => {
      clearTimeout(retryTimer.current);
      clearTimeout(deadlineTimer.current);
      controller.current?.abort();
      checking.current = false;
    };
  }, [preload, warm, cycle, finish, checkReadiness]);

  const imagePath = attempt ? `${canonicalPath}&retry=${String(attempt)}` : canonicalPath;
  const srcSet = productId ? productImageSrcSet(imagePath) : undefined;
  if (preload) {
    preloadResource(imagePath, { as: "image", fetchPriority: "high", ...(srcSet ? { imageSrcSet: srcSet, imageSizes: sizes } : {}) });
  }
  if (preloadAlternateColors && warm) {
    for (const alternateColor of productProjectionSpecification(baseProductSlug).colors) {
      if (alternateColor.toLowerCase() === color.toLowerCase()) continue;
      const alternatePath = productImagePath({
        baseProductSlug, color: alternateColor, designId, revision,
        ...(productId ? { productId } : {}),
      });
      preloadResource(alternatePath, {
        as: "image", fetchPriority: "low", type: "image/webp",
        ...(productId ? { imageSrcSet: productImageSrcSet(alternatePath), imageSizes: sizes } : {}),
      });
    }
  }

  return (
    <div
      className={cn(
        "relative aspect-square w-full overflow-hidden bg-white",
        className,
      )}
      role="group"
      aria-label={ariaLabel}
    >
      {productId && status !== "ready" && !accessDenied && (preload || warm) ?
        <BrowserProductPreview baseProductSlug={baseProductSlug} productId={productId} revision={revision} color={color} onReady={previewReady} /> : null}
      {/* eslint-disable-next-line @next/next/no-img-element -- Revocable endpoint supplies bounded responsive WebP sizes. */}
      <img
        ref={imageRef}
        width={1500}
        height={1500}
        loading={preload || warm ? "eager" : "lazy"}
        fetchPriority={preload ? "high" : "low"}
        onLoad={() => { finish("ready"); }}
        onError={() => {
          if (attempt === 0) void checkReadiness();
          else retryTimer.current = setTimeout(() => { void checkReadiness(); }, 2_000);
        }}
        srcSet={srcSet}
        src={imagePath}
        alt={ariaLabel}
        sizes={sizes}
        className="absolute inset-0 size-full object-contain"
        style={{ visibility: status === "ready" ? "visible" : "hidden" }}
      />
      {status !== "ready" && (!browserReady || accessDenied) ? (
        <div className="absolute inset-0 grid place-content-center gap-3 px-5 text-center font-mono text-xs text-primary">
          <p role="status">{status === "loading" ? "Preparing preview…" : status === "slow" ? "Preview is taking longer than expected." : "Preview could not be loaded."}</p>
          {status !== "loading" ? <button type="button" className="min-h-11 underline underline-offset-4"
            onClick={() => { settled.current = false; setAccessDenied(false); setStatus("loading"); setAttempt(value => value + 1); setCycle(value => value + 1); }}>
            Try again
          </button> : null}
        </div>
      ) : null}
    </div>
  );
});
