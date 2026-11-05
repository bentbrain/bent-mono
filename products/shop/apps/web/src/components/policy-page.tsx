import type { ReactNode } from "react";

export function PolicyPage({
  children,
  intro,
  lastUpdated = "29 August 2026",
  title,
}: {
  children: ReactNode;
  intro: ReactNode;
  lastUpdated?: string;
  title: string;
}) {
  return (
    <main className="flex-1 bg-background px-[clamp(1rem,8vw,9rem)] pt-24 pb-16 text-primary">
      <article className="mx-auto max-w-4xl">
        <p className="text-[0.68rem] font-bold tracking-[0.1em]">
          Last updated {lastUpdated}
        </p>
        <h1 className="mt-3 text-[clamp(2.8rem,8vw,6.5rem)] leading-[0.9] tracking-[-0.07em]">
          {title}
        </h1>
        <div className="mt-8 max-w-3xl text-[clamp(0.9rem,1.8vw,1.05rem)] leading-7">
          {intro}
        </div>
        <div className="mt-12 grid gap-10 text-sm leading-7">
          {children}
        </div>
      </article>
    </main>
  );
}

export function PolicySection({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <section className="grid gap-4 border-t border-primary/35 pt-5">
      <h2 className="text-lg font-bold tracking-[-0.03em]">{title}</h2>
      {children}
    </section>
  );
}

export const policyListClassName = "grid list-disc gap-2 pl-5";
