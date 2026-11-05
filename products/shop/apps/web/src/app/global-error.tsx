"use client";

import { useEffect } from "react";
import { captureClientException } from "@/client/posthog";

export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => { captureClientException(error); }, [error]);

  return (
    <html lang="en">
      <body>
        <main
          style={{
            alignItems: "center",
            display: "grid",
            fontFamily: "monospace",
            minHeight: "100vh",
            padding: "2rem",
            textAlign: "center",
          }}
        >
          <div>
            <h1>We couldn&apos;t load this page.</h1>
            <p>Please try again. Your saved work won&apos;t be changed.</p>
            <button type="button" onClick={retry}>
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
