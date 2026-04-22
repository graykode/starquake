import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Standalone output emits a self-contained server + minimal node_modules so the
  // Docker runtime image doesn't need `pnpm install` or the monorepo context.
  output: "standalone",
};

export default nextConfig;
