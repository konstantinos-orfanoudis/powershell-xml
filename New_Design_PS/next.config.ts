// New_Design_PS/next.config.ts
import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname),
  productionBrowserSourceMaps: false,
  eslint: { ignoreDuringBuilds: true },
  // output: 'standalone',
};

export default nextConfig;
//
