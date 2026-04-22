import type { NextConfig } from "next";

// GitHub Pages deploy: static export under `graykode.github.io/starquake/`.
const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "export",
  basePath: "/starquake",
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
