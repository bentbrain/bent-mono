import type { Metadata } from "next";
import "@bent/design-tokens/tokens.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Home",
  description:
    "Interactive isometric 3D apartment viewer with two animated cats and simulated lighting.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
