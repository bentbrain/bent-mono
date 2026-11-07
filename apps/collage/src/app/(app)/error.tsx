"use client"; // Error boundaries must be Client Components

import { useEffect } from "react";
import { Card } from "../_components/ui/card";
import { Button } from "../_components/ui/button";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log the error to an error reporting service
    console.error(error);
  }, [error]);

  return (
    <div className="container mx-auto grid place-items-center">
      <Card className="grid w-full place-items-center gap-8 p-4 md:w-auto">
        <h2>This page could not load.</h2>
        <Button
          variant={"outline"}
          onClick={
            // Attempt to recover by trying to re-render the segment
            () => reset()
          }
        >
          Try again
        </Button>
      </Card>
    </div>
  );
}
