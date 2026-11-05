"use client";

import { useEffect, useRef } from "react";
import { useInView } from "react-intersection-observer";

interface InfiniteScrollTriggerProps {
  onInView: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
}

export function InfiniteScrollTrigger({
  onInView,
  hasNextPage,
  isFetchingNextPage,
}: InfiniteScrollTriggerProps) {
  const elementRef = useRef<HTMLDivElement>(null);
  const [setRef] = useInView({
    onChange: (inView) => {
      if (inView && hasNextPage && !isFetchingNextPage) {
        onInView();
      }
    },
    rootMargin: "2000px 0px",
    threshold: 0,
  });

  useEffect(() => {
    if (elementRef.current) {
      setRef(elementRef.current);
    }
  }, [setRef]);

  return <div ref={elementRef} className="h-10" />;
}
