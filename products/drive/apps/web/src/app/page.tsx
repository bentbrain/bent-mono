import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

const steps = [
  {
    number: "01",
    title: "Add the plugin",
    description:
      "Codex or ChatGPT discovers the hosted MCP service and requests a secure connection.",
  },
  {
    number: "02",
    title: "Approve with Tesla",
    description: "You sign in directly with Tesla and choose the read-only vehicle permission.",
  },
  {
    number: "03",
    title: "Ask about the car",
    description:
      "Check battery, range, charging, locks, climate and Sentry state in conversation.",
  },
];

const securityFeatures = [
  "Tesla OAuth",
  "Encrypted rotating tokens",
  "Per-user isolation",
  "No vehicle commands",
];

export default function Home() {
  return (
    <main className="relative min-h-screen overflow-hidden bg-background text-foreground">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[34rem] bg-[radial-gradient(circle_at_50%_-10%,color-mix(in_oklch,var(--primary)_22%,transparent),transparent_62%)]" />
      <div className="relative mx-auto flex min-h-screen w-full max-w-6xl flex-col px-6 py-8 sm:px-10 lg:px-14">
        <header className="flex items-center justify-between gap-4 pb-6">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-primary text-sm font-black tracking-tight text-primary-foreground shadow-[0_0_30px_color-mix(in_oklch,var(--primary)_25%,transparent)]">
              BD
            </span>
            <div>
              <p className="text-sm font-semibold">Bent Drive Copilot</p>
              <p className="text-xs text-muted-foreground">Private vehicle intelligence</p>
            </div>
          </div>
          <Button asChild variant="ghost">
            <Link href="/docs">Integration docs</Link>
          </Button>
        </header>
        <Separator />

        <section className="grid flex-1 items-center gap-14 py-20 lg:grid-cols-[1.15fr_0.85fr] lg:py-28">
          <div>
            <Badge className="mb-7 gap-2 px-3 py-1.5 text-muted-foreground" variant="outline">
              <span className="size-1.5 rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.8)]" />
              Read-only pilot
            </Badge>
            <h1 className="max-w-3xl text-5xl leading-[0.96] font-semibold tracking-[-0.065em] sm:text-7xl">
              Your Tesla,
              <span className="block text-muted-foreground">in the conversation.</span>
            </h1>
            <p className="mt-8 max-w-xl text-lg leading-8 text-muted-foreground">
              Connect your Tesla account to approved AI tools without sharing your Tesla password.
              The first release can inspect vehicle state and cannot send commands.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              {securityFeatures.map((label) => (
                <Badge className="h-auto px-3 py-2 text-muted-foreground" key={label} variant="outline">
                  {label}
                </Badge>
              ))}
            </div>
          </div>

          <Card className="rounded-[2rem] bg-card/90 p-3 shadow-2xl shadow-black/40 backdrop-blur">
            <div className="rounded-[1.45rem] border bg-background/70 py-2">
              <CardHeader className="mb-4 flex-row items-center justify-between px-6 sm:px-8">
                <CardDescription className="text-xs font-semibold tracking-[0.2em] uppercase">
                  Connection flow
                </CardDescription>
                <Badge className="border-0 bg-emerald-400/10 text-emerald-300" variant="outline">
                  OAuth 2.1
                </Badge>
              </CardHeader>
              <CardContent className="px-6 pb-4 sm:px-8 sm:pb-6">
                <ol className="space-y-7">
                  {steps.map((step) => (
                    <li className="grid grid-cols-[2.5rem_1fr] gap-4" key={step.number}>
                      <span className="font-mono text-xs text-primary">{step.number}</span>
                      <div>
                        <CardTitle>
                          <h2>{step.title}</h2>
                        </CardTitle>
                        <CardDescription className="mt-1.5 leading-6">
                          {step.description}
                        </CardDescription>
                      </div>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </div>
          </Card>
        </section>

        <Separator />
        <footer className="flex flex-col gap-3 py-4 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>Built by Bent Build · Not affiliated with Tesla, Inc.</p>
          <nav aria-label="Legal and service links" className="flex flex-wrap gap-1">
            <Button asChild size="xs" variant="link">
              <Link href="/privacy">Privacy</Link>
            </Button>
            <Button asChild size="xs" variant="link">
              <Link href="/terms">Terms</Link>
            </Button>
            <Button asChild size="xs" variant="link">
              <Link href="/api/health">Service status</Link>
            </Button>
          </nav>
        </footer>
      </div>
    </main>
  );
}
