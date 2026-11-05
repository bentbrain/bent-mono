import { withPayload } from "@payloadcms/next/withPayload";
/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import "./src/env.js";

/** @type {import("next").NextConfig} */
const config = {
  cacheComponents: true,
  outputFileTracingIncludes: {
    "/*": [
      "../../node_modules/@img/sharp-libvips-linux-x64/lib/**/*",
    ],
  },
  images: {
    minimumCacheTTL: 2678400,
    qualities: [60, 75],
    remotePatterns: [
      {
        hostname: "utfs.io",
      },
      {
        protocol: "https",
        hostname: "qkok536o5n.ufs.sh",
      },
      {
        protocol: "https",
        hostname: "pub-2283e02a54584f039149f33badc20873.r2.dev",
      },
      {
        protocol: "https",
        hostname: "media.maya-collage.bent.build",
      },
      {
        hostname: "img.clerk.com",
      },
      {
        hostname: "localhost",
      },
    ],
  },
};

export default withPayload(config);
