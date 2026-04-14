import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  async headers() {
    return [
      {
        // OAuth client metadata — changes very rarely
        source: "/client-metadata.json",
        headers: [
          { key: "Cache-Control", value: "public, max-age=86400" },
        ],
      },
      {
        // ISR pages — browser can cache briefly, revalidate in background
        source: "/((?!api|_next).*)",
        headers: [
          { key: "Cache-Control", value: "public, max-age=300, stale-while-revalidate=3600" },
        ],
      },
    ];
  },
};

export default nextConfig;
