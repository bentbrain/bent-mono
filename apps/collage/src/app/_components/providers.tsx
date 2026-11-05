// app/providers.jsx
"use client";

import { env } from "@/env";
import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { useEffect } from "react";

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  const posthogKey = env.NEXT_PUBLIC_POSTHOG_KEY;
  const posthogHost = env.NEXT_PUBLIC_POSTHOG_HOST;

  useEffect(() => {
    if (!posthogKey || !posthogHost) return;

    posthog.init(posthogKey, {
      api_host: posthogHost,
      capture_pageview: false,
    });
  }, [posthogHost, posthogKey]);

  if (!posthogKey || !posthogHost) return children;

  return <PHProvider client={posthog}>{children}</PHProvider>;
}
