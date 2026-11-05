import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";

import { AppShell } from "@/app/app-shell";
import {
  SOCIAL_CARD_DESCRIPTION,
  createSocialCardMetadata,
  featuredSocialCardPath,
} from "@/lib/social-card";

import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://shop.bent.build"),
  ...createSocialCardMetadata({
    alt: "Black T-shirt with the featured bent.shop design",
    canonicalPath: "/",
    documentTitle: "bent.shop",
    imagePath: featuredSocialCardPath("staple-tee", "Black"),
    sharePath: "/",
  }),
  description: SOCIAL_CARD_DESCRIPTION,
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-dvh flex-col">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
