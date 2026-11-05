import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

export default function PrivacyPage() {
  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-16 sm:px-10">
      <Button asChild className="-ml-2" variant="ghost">
        <Link href="/">← Bent Drive Copilot</Link>
      </Button>
      <h1 className="mt-10 text-4xl font-semibold tracking-[-0.04em]">Privacy</h1>
      <Separator className="my-8" />
      <Card>
        <CardContent className="space-y-5 py-2 leading-7 text-muted-foreground">
          <p>
            Bent Drive Copilot stores encrypted Tesla OAuth tokens so an authenticated connection
            can read the vehicle information you authorize.
          </p>
          <p>
            Vehicle responses are returned to the requesting MCP client. Tesla credentials and
            refresh tokens are never included in tool results or exposed to the AI model.
          </p>
          <p>
            The read-only pilot does not sell personal data and does not request vehicle-location or
            vehicle-command permissions.
          </p>
          <p>
            Before public release, this notice will be expanded with retention, deletion and
            operator contact details.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
