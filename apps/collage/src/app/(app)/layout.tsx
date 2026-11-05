import "@/styles/globals.css";
import { TRPCReactProvider } from "@/trpc/react";
import { HydrateClient } from "@/trpc/server";
import { Show } from "@clerk/nextjs";
import { GeistSans } from "geist/font/sans";
import { type Metadata } from "next";
import { cacheLife } from "next/cache";
import Link from "next/link";
import { Suspense } from "react";
import { AppSidebar } from "../_components/app-sidebar";
import HeaderAuthLinks from "../_components/header-auth-links";
import NsfwPreferenceWrapper from "../_components/nsfw-preference-wrapper";
import { PostHogProvider } from "../_components/providers";
import SidbarTriggerWrapper from "../_components/sidebar-trigger-wrapper";
import { Button } from "../_components/ui/button";
import { SidebarProvider } from "../_components/ui/sidebar";

export const metadata: Metadata = {
  metadataBase: new URL("https://maya-collage.bent.build"),
  title: "Maya's Collages",
  description: "Custom collages made for Maya's birthday.",
  icons: [{ rel: "icon", url: "/favicon.ico" }],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${GeistSans.variable} `}>
      <PostHogProvider>
        <body className="bg-stone-100 font-mono">
          <SidebarProvider>
            <AppSidebar />
            <div className="isolate grid min-h-dvh w-full grid-rows-[auto,1fr] overflow-hidden bg-pink-600 text-white">
              <header className="grid grid-cols-3 place-items-center border-b-4 border-black bg-stone-100 p-4 text-black">
                <Suspense fallback={null}>
                  <SidbarTriggerWrapper />
                </Suspense>
                <div className="flex w-full justify-center sm:col-start-1 sm:justify-start lg:col-start-2 lg:justify-center">
                  <Button variant={"outline"} asChild size={"lg"}>
                    <Link href={"/"} prefetch={true}>
                      Maya&apos;s Collages
                    </Link>
                  </Button>
                </div>
                <div className="col-start-3 flex w-full justify-end">
                  <div className="hidden justify-end gap-3 sm:flex">
                    <Suspense fallback={null}>
                      <HeaderAuthLinks />
                    </Suspense>
                  </div>
                </div>
              </header>
              <TRPCReactProvider>
                <HydrateClient>
                  <Suspense fallback={<MainContentSkeleton />}>
                    <div className="p-3 md:p-6">{children}</div>
                  </Suspense>
                </HydrateClient>
                <Suspense fallback={null}>
                  <Show when="signed-in">
                    <NsfwPreferenceWrapper />
                  </Show>
                </Suspense>
              </TRPCReactProvider>
              <footer className="text-centre grid place-items-center p-4 text-xs">
                <Copyright />
              </footer>
            </div>
          </SidebarProvider>
        </body>
      </PostHogProvider>
    </html>
  );
}

function MainContentSkeleton() {
  return <div className="min-h-[50vh] p-3 md:p-6" aria-busy="true" />;
}

async function Copyright() {
  "use cache";

  cacheLife("days");
  const currentYear = new Date().getFullYear();
  return (
    <p>
      &copy; {currentYear} |{" "}
      <Link className="hover:underline" href={"/privacy-policy"}>
        Privacy Policy
      </Link>
    </p>
  );
}
