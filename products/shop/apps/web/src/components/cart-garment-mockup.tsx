"use client";

import Image from "next/image";
import { BrowserProductPreview } from "@/components/browser-product-preview";
import { useCallback, useEffect, useRef, useState } from "react";

import { cartProductImagePath } from "@/lib/product-image";

interface CartGarmentMockupProps {
  preparationRevision?: string | undefined;
  color: string;
  productId: string;
  sizes: string;
  title: string;
}

export function CartGarmentMockup({
  color,
  preparationRevision,
  productId,
  sizes,
  title,
}: CartGarmentMockupProps) {
  const canonicalPath = cartProductImagePath({ color, productId });
  const [readyPath, setReadyPath] = useState("");
  const previewReady = useCallback(() => undefined, []);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [retry, setRetry] = useState({ path: "", attempt: 0 });
  const attempt = retry.path === canonicalPath ? retry.attempt : 0;
  useEffect(() => () => { clearTimeout(timer.current); }, [canonicalPath]);
  return (
    <div
      className="relative aspect-square w-full overflow-hidden border border-primary bg-white"
      role="img"
      aria-label={`${color} ${title} with your design`}
    >
      {preparationRevision && readyPath !== canonicalPath ? <BrowserProductPreview
        productId={productId} revision={preparationRevision} color={color} onReady={previewReady}
      /> : null}
      <Image
        fill
        unoptimized
        src={attempt ? `${canonicalPath}&retry=${String(attempt)}` : canonicalPath}
        onLoad={() => { setReadyPath(canonicalPath); }}
        onError={() => {
          if (attempt >= 30) return;
          clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            setRetry({ path: canonicalPath, attempt: attempt + 1 });
          }, 2000);
        }}
        alt=""
        sizes={sizes}
        className={`object-contain ${preparationRevision && readyPath !== canonicalPath ? "opacity-0" : ""}`}
      />
    </div>
  );
}
