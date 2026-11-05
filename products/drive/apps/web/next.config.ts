import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@bent-build/tesla-contracts"],
  async headers() {
    return [
      {
        source: "/.well-known/appspecific/com.tesla.3p.public-key.pem",
        headers: [
          { key: "Content-Type", value: "application/x-pem-file; charset=utf-8" },
          { key: "Cache-Control", value: "public, max-age=300" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
