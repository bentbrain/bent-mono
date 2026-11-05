import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "bent.stay",
  description: "Apartment guide.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <ClerkProvider
          appearance={{
            variables: {
              colorPrimary: "var(--blue)",
              colorPrimaryForeground: "var(--background)",
              colorBorder: "var(--blue)",
              colorForeground: "var(--blue)",
              colorMutedForeground: "var(--blue)",
              colorBackground: "var(--background)",
              colorInput: "var(--background)",
              colorInputForeground: "var(--blue)",
              borderRadius: "0",
              fontFamily: "var(--font-geist-mono)",
            },
            elements: {
              cardBox: "w-full",
              rootBox: "w-full",
              card: "shadow-none border border-border",
            },
          }}
        >
          {children}
        </ClerkProvider>
      </body>
    </html>
  );
}
