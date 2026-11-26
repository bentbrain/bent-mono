import posthog from "posthog-js";

const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;

// Analytics run only where the project key is configured (production on Vercel).
if (posthogKey) {
  posthog.init(posthogKey, {
    // Events go through the /ingest rewrite in next.config.ts so ad blockers
    // that block PostHog's domain still let traffic through.
    api_host: "/ingest",
    ui_host: "https://us.posthog.com",
    defaults: "2026-08-30",
    // Keep analytics state in memory: no cookies or browser storage on the
    // visitor's device. Each page load counts as a new anonymous visit.
    persistence: "memory",
    person_profiles: "never",
    disable_session_recording: true,
  });
}
