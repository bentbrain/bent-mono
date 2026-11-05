import type { NextConfig } from "next";
import { withPostHogConfig } from "@posthog/nextjs-config";

import { storefrontSecurityHeaders } from "./src/config/security-headers";
import { env } from "./src/env";

const lanDevOrigin = env.LAN_DEV_ORIGIN;
const allowedDevOrigins = ["127.0.0.1", "*.trycloudflare.com"];

if (lanDevOrigin) {
  allowedDevOrigins.push(lanDevOrigin);
}

const sourceCommit = /^[a-f0-9]{40}$/.test(process.env["VERCEL_GIT_COMMIT_SHA"] ?? "")
  ? process.env["VERCEL_GIT_COMMIT_SHA"] : undefined;

const nextConfig: NextConfig = {
  // Commit identity is public; only this bounded value enters browser bundles.
  env: { NEXT_PUBLIC_SOURCE_COMMIT: sourceCommit ?? "local" },
  allowedDevOrigins,
  cacheComponents: true,
  serverExternalPackages: ["@forever-tee/product-image-renderer"],
  outputFileTracingIncludes: {
    "/api/internal/product-image-render": ["./public/mockups/lifestyle-v4/**/*", "../../packages/product-image-renderer/assets/displacement.wasm"],
  },
  devIndicators: false,
  headers() {
    return [
      {
        headers: storefrontSecurityHeaders({
          includeStrictTransportSecurity:
            process.env["VERCEL_ENV"] === "production",
        }),
        source: "/:path*",
      },
      {source: "/mockups/lifestyle-v4/:path*", headers: [{key: "Cache-Control", value: "public, max-age=31536000, immutable"}]},
      {source: "/manage-order", headers: [{key: "Referrer-Policy", value: "no-referrer"}]},
    ];
  },
  images: {
    minimumCacheTTL: 31_536_000,
    remotePatterns: [
      {
        hostname: "cdn.shopify.com",
        protocol: "https",
      },
    ],
  },
  partialPrefetching: true,
  rewrites() {
    return [
      {
        source: "/api/forever-tee/:path*",
        destination: `${env.FOREVER_TEE_API_URL.replace(/\/$/, "")}/:path*`,
      },
    ];
  },
  transpilePackages: ["@forever-tee/contracts", "three"],
};

const posthogApiKey = process.env["POSTHOG_CLI_API_KEY"];
const posthogProjectId = process.env["POSTHOG_CLI_PROJECT_ID"];
const posthogHost = process.env["POSTHOG_CLI_HOST"];

// Only hosted release builds upload artifacts. Fixture builds have no credentials.
export default process.env["VERCEL"] === "1" && posthogApiKey && posthogProjectId && posthogHost
  ? withPostHogConfig(nextConfig, {
      personalApiKey: posthogApiKey,
      projectId: posthogProjectId,
      host: posthogHost,
      sourcemaps: { enabled: true, deleteAfterUpload: true, releaseName: "bent.shop-web", ...(sourceCommit ? { releaseVersion: sourceCommit } : {}) },
    })
  : nextConfig;
