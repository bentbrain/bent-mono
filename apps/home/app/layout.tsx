import type { Metadata } from "next";
import "@bent/design-tokens/tokens.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Home",
  description:
    "A little home, with Pearl and Maree.",
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
