import HomeButton from "@/components/home-scramble-button";
import { AppIcon } from "@/components/showcase/app-icon";
import { AppSection } from "@/components/showcase/app-section";
import { PhoneFrame } from "@/components/showcase/device-frames";
import { apps } from "@/lib/apps";
import { getImageProps } from "next/image";
import { preload } from "react-dom";

const heroApps = ["home", "fitness", "shop"].flatMap((id) =>
  apps.filter((app) => app.id === id),
);
const heroImageSizes = "12rem";

function HeroPhones() {
  // The hero is hidden below the lg breakpoint, so preload its images for
  // wide screens only instead of marking them as priority images.
  for (const app of heroApps) {
    const { props } = getImageProps({
      src: app.mobile.image,
      alt: "",
      sizes: heroImageSizes,
    });
    preload(props.src, {
      as: "image",
      imageSrcSet: props.srcSet,
      imageSizes: props.sizes,
      media: "(min-width: 1024px)",
      fetchPriority: "high",
    });
  }
  return (
    <div aria-hidden="true" className="relative hidden h-[28rem] lg:block">
      {heroApps.map((app, index) => (
        <PhoneFrame
          key={app.id}
          image={app.mobile.image}
          alt=""
          sizes={heroImageSizes}
          className={
            [
              "absolute left-0 top-10 w-44 -rotate-6",
              "absolute left-1/2 top-0 z-10 w-48 -translate-x-1/2",
              "absolute right-0 top-10 w-44 rotate-6",
            ][index]
          }
        />
      ))}
    </div>
  );
}

export default function Home() {
  return (
    <>
      <header className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 md:px-8">
          <HomeButton />
          <a
            href="#apps"
            className="font-mono text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {apps.length} apps
          </a>
        </div>
      </header>

      <main>
        <section
          aria-labelledby="intro-title"
          className="mx-auto max-w-6xl px-4 pb-12 pt-14 md:px-8 md:pb-16 md:pt-24"
        >
          <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_26rem]">
            <div>
              <h1
                id="intro-title"
                className="max-w-3xl text-4xl font-semibold tracking-tight text-balance md:text-6xl"
              >
                Apps on bent.build
              </h1>
              <p className="mt-5 max-w-2xl text-lg text-muted-foreground text-pretty">
                Each app below runs on its own bent.build subdomain. Some are
                open to everyone; others need a sign-in or an invitation.
              </p>
            </div>
            <HeroPhones />
          </div>

          <nav aria-label="Apps" id="apps" className="mt-12 scroll-mt-20">
            <ul className="grid grid-cols-1 gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
              {apps.map((app) => (
                <li key={app.id} className="bg-background">
                  <a
                    href={`#${app.id}`}
                    className="group flex items-center gap-4 p-4 transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-cobalt"
                  >
                    <AppIcon id={app.id} className="size-12" />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{app.name}</span>
                      <span className="block text-sm text-muted-foreground">
                        {app.tagline}
                      </span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </section>

        {apps.map((app) => (
          <AppSection key={app.id} app={app} />
        ))}
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-8 font-mono text-xs text-muted-foreground md:px-8">
          <span>bent.build</span>
          <a
            href="#apps"
            className="underline-offset-4 hover:text-foreground hover:underline"
          >
            Back to all apps
          </a>
        </div>
      </footer>
    </>
  );
}
