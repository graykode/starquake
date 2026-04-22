import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#08080a",
        panel: "#0d0d10",
        card: "#131317",
        line: "#1e1e24",
        line2: "#2a2a32",
        muted: "#6e6e78",
        dim: "#a1a1aa",
        fg: "#ededed",
        accent: "#fbbf24",
        accent2: "#f59e0b",
      },
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "-apple-system",
          "SF Pro Text",
          "Inter",
          "system-ui",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SF Mono",
          "JetBrains Mono",
          "Menlo",
          "monospace",
        ],
      },
      keyframes: {
        pulse: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
      },
      animation: {
        pulse: "pulse 1.4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
