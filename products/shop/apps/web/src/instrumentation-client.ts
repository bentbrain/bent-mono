import { installCartDiagnostics } from "./client/cart-diagnostics";
import { initializePostHog, stopCaptureForPrivatePage } from "./client/posthog";

initializePostHog(
  process.env["NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN"],
  process.env["NEXT_PUBLIC_POSTHOG_HOST"],
);

installCartDiagnostics();

export function onRouterTransitionStart(url: string) {
  stopCaptureForPrivatePage(url);
}
