"use client";

import { useEffect } from "react";
import { captureClientException } from "@/client/posthog";

import { Button } from "@/components/ui/button";

export default function DesignError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => { captureClientException(error); }, [error]);

  return (
    <main className="grid flex-1 place-items-center bg-background px-5 py-16 text-center text-primary">
      <div className="w-[min(100%,32rem)]">
        <p className="text-xs tracking-[0.08em]">Design saved</p>
        <h1 className="mt-3 text-4xl leading-tight font-bold tracking-[-0.04em]">
          We couldn&apos;t load your design.
        </h1>
        <p className="mx-auto mt-4 max-w-[28rem] text-sm leading-6">
          This can happen when the connection drops. Your saved design
          won&apos;t be changed when you try again.
        </p>
        <Button
          type="button"
          className="mt-8 min-h-14 rounded-none border border-primary bg-primary px-[1.4rem] py-4 font-mono text-[0.72rem] font-bold tracking-[0.06em] text-primary-foreground uppercase hover:bg-background hover:text-primary"
          onClick={retry}
        >
          Try again
        </Button>
      </div>
    </main>
  );
}
