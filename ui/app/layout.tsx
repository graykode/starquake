import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "starquake",
  description: "Near-real-time GitHub stargazing dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="bg-bg">
      <body className="bg-bg text-fg font-sans antialiased">{children}</body>
    </html>
  );
}
