import { Button } from "@/components/ui/button";
import type { ShowcaseApp } from "@/lib/apps";
import { AppIcon } from "./app-icon";
import { BrowserFrame, PhoneFrame } from "./device-frames";

export function AppSection({ app }: Readonly<{ app: ShowcaseApp }>) {
  const headingId = `${app.id}-title`;
  return (
    <section
      id={app.id}
      aria-labelledby={headingId}
      className="scroll-mt-20 border-t border-border py-12 md:py-16"
    >
      <div className="mx-auto max-w-6xl px-4 md:px-8">
        <header className="flex flex-wrap items-center gap-4 md:gap-6">
          <AppIcon id={app.id} className="size-16 md:size-24" />
          <div className="min-w-0 flex-1">
            <p className="font-mono text-xs uppercase tracking-wider text-cobalt">
              {app.category}
            </p>
            <h2
              id={headingId}
              className="mt-1 text-2xl font-semibold tracking-tight md:text-4xl"
            >
              {app.name}
            </h2>
            <p className="mt-1 text-muted-foreground md:text-lg">
              {app.tagline}
            </p>
          </div>
          <div className="flex w-full gap-2 sm:w-auto">
            {app.source ? (
              <Button
                asChild
                size="lg"
                variant="outline"
                className="flex-1 font-mono sm:flex-none"
              >
                <a href={app.source} target="_blank" rel="noopener noreferrer">
                  Source
                  <span className="sr-only">
                    {" "}
                    code for {app.name} (opens in a new tab)
                  </span>
                  <span aria-hidden="true">↗</span>
                </a>
              </Button>
            ) : null}
            <Button asChild size="lg" className="flex-1 font-mono sm:flex-none">
              <a
                href={`https://${app.domain}/`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open
                <span className="sr-only"> {app.name} (opens in a new tab)</span>
                <span aria-hidden="true">↗</span>
              </a>
            </Button>
          </div>
        </header>
      </div>

      <div
        role="group"
        aria-label={`${app.name} screenshots`}
        tabIndex={0}
        className="mt-8 flex snap-x snap-mandatory scroll-px-4 items-start gap-4 md:items-end overflow-x-auto px-4 pb-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt md:mx-auto md:max-w-6xl md:scroll-px-8 md:gap-6 md:px-8"
      >
        <BrowserFrame
          image={app.desktop.image}
          alt={app.desktop.alt}
          domain={app.domain}
        />
        <PhoneFrame
          className="order-first md:order-none"
          image={app.mobile.image}
          alt={app.mobile.alt}
          statusBar={app.mobile.statusBar}
        />
      </div>

      <div className="mx-auto mt-8 grid max-w-6xl gap-8 px-4 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] md:px-8">
        <div>
          <p className="max-w-prose text-base leading-relaxed md:text-lg">
            {app.description}
          </p>
          <ul className="mt-5 grid gap-2 sm:grid-cols-2">
            {app.highlights.map((highlight) => (
              <li key={highlight} className="flex gap-2 text-sm">
                <span
                  aria-hidden="true"
                  className="mt-1.5 size-1.5 shrink-0 bg-cobalt"
                />
                {highlight}
              </li>
            ))}
          </ul>
        </div>
        <dl className="grid grid-cols-2 content-start gap-px self-start border border-border bg-border font-mono text-xs">
          <InfoItem label="Domain" value={app.domain} />
          <InfoItem label="Access" value={app.access} />
        </dl>
      </div>
    </section>
  );
}

function InfoItem({
  label,
  value,
}: Readonly<{ label: string; value: string }>) {
  return (
    <div className="bg-background p-3">
      <dt className="uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 break-words text-foreground">{value}</dd>
    </div>
  );
}
