"use client";

import { useEffect } from "react";

export function useViewportScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return;

    const root = document.documentElement;
    const body = document.body;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const previousRootOverflow = root.style.overflow;
    const previousRootOverscrollBehavior = root.style.overscrollBehavior;
    const previousBodyOverflow = body.style.overflow;
    const previousBodyOverscrollBehavior = body.style.overscrollBehavior;
    const previousBodyPosition = body.style.position;
    const previousBodyTop = body.style.top;
    const previousBodyLeft = body.style.left;
    const previousBodyWidth = body.style.width;

    root.style.overflow = "hidden";
    root.style.overscrollBehavior = "none";
    body.style.overflow = "hidden";
    body.style.overscrollBehavior = "none";
    body.style.position = "fixed";
    body.style.top = `${String(-scrollY)}px`;
    body.style.left = `${String(-scrollX)}px`;
    body.style.width = "100%";

    return () => {
      root.style.overflow = previousRootOverflow;
      root.style.overscrollBehavior = previousRootOverscrollBehavior;
      body.style.overflow = previousBodyOverflow;
      body.style.overscrollBehavior = previousBodyOverscrollBehavior;
      body.style.position = previousBodyPosition;
      body.style.top = previousBodyTop;
      body.style.left = previousBodyLeft;
      body.style.width = previousBodyWidth;
      window.scrollTo({ behavior: "auto", left: scrollX, top: scrollY });
    };
  }, [locked]);
}
