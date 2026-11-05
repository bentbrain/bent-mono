import { diagnosticRequestId } from "@forever-tee/contracts/diagnostics";
import posthog, { type CaptureResult, type PostHogConfig } from "posthog-js";

const privatePage = /\/manage-order(?:[/?#]|$)/;
let privateNavigation = false;
const publicPaths = new Set([
  "", "create", "design", "featured", "product", "cart", "privacy", "terms",
  "shipping", "returns", "content-rules", "contact", "camera", "edit",
]);

function analyticsUrl(value: string): string {
  try {
    const url = new URL(value, window.location.origin);
    if (!["http:", "https:"].includes(url.protocol)) return "[redacted]";
    // Keep bundle names for source-map lookup, but never query strings or hashes.
    const pathname = url.pathname.startsWith("/_next/static/")
      ? url.pathname
      : url.pathname.split("/").map((part) => publicPaths.has(part) ? part : "[id]").join("/");
    return `${url.origin}${pathname}`;
  } catch {
    return "[redacted]";
  }
}

function sanitizeProperties(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeProperties(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitizeProperties(item, name)]));
  }
  if (typeof value !== "string") return value;
  if (/^(\$exception_message|value|message|\$exception_stack_trace_raw)$/.test(key)) return "[redacted]";
  if (/url|href|referrer|pathname|abs_path|filename/i.test(key)) return analyticsUrl(value);
  return value;
}

export function beforeSend(event: CaptureResult | null): CaptureResult | null {
  if (!event || privateNavigation || privatePage.test(window.location.pathname)) return null;
  // Replay has its own masking before compression. Never rewrite its payload.
  if (event.event === "$snapshot") return event;
  const result: CaptureResult = {
    ...event,
    properties: { ...Object.fromEntries(Object.entries(event.properties)
      .filter(([key]) => !/^(\$set|\$set_once|\$initial_|\$session_entry_|utm_|gclid|fbclid)/.test(key))
      .map(([key, value]) => [key, sanitizeProperties(value, key)])),
      sourceCommit: /^[a-f0-9]{40}$/.test(process.env["NEXT_PUBLIC_SOURCE_COMMIT"] ?? "") ? process.env["NEXT_PUBLIC_SOURCE_COMMIT"] : undefined,
    },
  };
  delete result.$set;
  delete result.$set_once;
  return result;
}

export const posthogOptions: Partial<PostHogConfig> = {
  defaults: "2026-05-30",
  capture_pageview: "history_change",
  autocapture: {
    url_ignorelist: [privatePage],
    capture_copied_text: false,
  },
  capture_exceptions: {
    capture_unhandled_errors: true,
    capture_unhandled_rejections: true,
    capture_console_errors: false,
  },
  person_profiles: "never",
  persistence: "sessionStorage",
  // IP retention is controlled by the protected project's Discard client IP
  // data setting; the retired SDK ip option no longer changes collection.
  mask_all_element_attributes: true,
  mask_all_text: true,
  capture_performance: false,
  enable_recording_console_log: false,
  disable_surveys: true,
  disable_product_tours: true,
  disable_web_experiments: true,
  // Flag evaluation sends initial URL properties outside before_send.
  advanced_disable_feature_flags: true,
  capture_heatmaps: false,
  session_recording: {
    maskAllInputs: true,
    maskTextSelector: '.ph-mask, .ph-sensitive, [data-ph-mask], [role="alert"]',
    inlineStylesheet: true,
    blockSelector: 'nextjs-portal, img, picture, video, canvas, svg image, iframe, object, embed, input[type="hidden"], input[type="file"], .ph-no-capture',
    captureCanvas: { recordCanvas: false },
    captureJsonLd: false,
    recordHeaders: false,
    recordBody: false,
    // rrweb stores inlined stylesheets in _cssText. Removing it loses all styling.
    // Keep presentation attributes, but exclude customer values and media URLs.
    maskAttributeFn: (name, value) => {
      if (name === "_cssText") return value;
      if (name === "href") {
        try {
          const url = new URL(value, window.location.origin);
          return url.origin === window.location.origin && url.pathname.startsWith("/_next/static/")
            ? `${url.origin}${url.pathname}`
            : "";
        } catch {
          return "";
        }
      }
      if (name === "style") return /url\s*\(/i.test(value) ? "" : value;
      return [
        "class", "width", "height", "role", "type", "rel", "media", "lang", "dir",
        "disabled", "checked", "selected", "open", "hidden", "tabindex",
        "data-state", "data-slot", "data-side", "data-orientation",
        "data-active", "data-disabled", "data-open", "data-closed", "data-pending",
        "data-available", "data-size", "data-icon", "data-position", "data-align-trigger",
        "data-variant", "data-placeholder", "aria-expanded", "aria-invalid", "aria-checked",
        "viewBox", "viewbox", "d", "fill", "stroke", "stroke-width", "stroke-linecap",
        "stroke-linejoin", "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry",
        "rr_width", "rr_height",
      ].includes(name) ? value : "";
    },
    maskCapturedNetworkRequestFn: (request) => ({ ...request, name: analyticsUrl(request.name) }),
  },
  before_send: beforeSend,
};

let initialized = false;
const capturedErrors = new WeakSet<Error>();

export function initializePostHog(token?: string, host?: string) {
  if (initialized || privatePage.test(window.location.pathname)) return;
  if (!token || !host) {
    if (process.env.NODE_ENV === "development") {
      console.warn("PostHog capture is disabled. Configure NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN and NEXT_PUBLIC_POSTHOG_HOST to enable it.");
    }
    return;
  }
  try {
    posthog.init(token, { ...posthogOptions, api_host: host });
    initialized = true;
  } catch {
    // Observability must not stop the customer journey.
    console.warn("PostHog could not initialize.");
  }
}

export interface ClientFailureContext {
  readonly operation: "design_request" | "artwork_upload" | "background_removal" |
    "configured_product_creation" | "configured_product_family_creation" | "cart_mutation" | "checkout";
  readonly status?: number | undefined;
  readonly code?: string | undefined;
  readonly requestId?: string | undefined;
}

function failureProperties(context: ClientFailureContext) {
  return {
    operation: context.operation,
    status: context.status !== undefined && Number.isInteger(context.status) && context.status >= 0 && context.status <= 599 ? context.status : undefined,
    code: context.code && /^[A-Z0-9_]{1,64}$/.test(context.code) ? context.code : undefined,
    requestId: diagnosticRequestId(context.requestId),
  };
}

export function captureStorefrontFailure(context: ClientFailureContext) {
  if (!initialized || privateNavigation || privatePage.test(window.location.pathname)) return;
  try {
    posthog.capture("storefront_failure", failureProperties(context));
  } catch {
    // Reporting cannot change the customer's recovery path.
  }
}

export function captureClientException(error: Error, context?: ClientFailureContext) {
  if (!initialized || privateNavigation || capturedErrors.has(error) || privatePage.test(window.location.pathname)) return;
  try {
    posthog.captureException(error, context ? failureProperties(context) : undefined);
    capturedErrors.add(error);
  } catch {
    // Preserve the existing error recovery even if capture fails.
  }
}

export function captureStorefrontAction(action: "camera_open_requested" | "image_upload_started" | "cart_add_requested" | "checkout_requested") {
  if (!initialized || privateNavigation || privatePage.test(window.location.pathname)) return;
  try {
    posthog.capture(action);
  } catch {
    // Capture is best-effort and must not interrupt the action.
  }
}

export function stopCaptureForPrivatePage(url: string) {
  if (!initialized || !privatePage.test(url)) return;
  // Stop before the router commits private content. A fresh document resumes capture.
  privateNavigation = true;
  posthog.stopSessionRecording();
  posthog.set_config({ disable_session_recording: true, autocapture: false, capture_pageview: false, capture_exceptions: false });
}
