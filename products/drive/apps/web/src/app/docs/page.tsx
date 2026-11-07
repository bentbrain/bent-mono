import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

export default function DocsPage() {
  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-16 text-foreground sm:px-10">
      <Button asChild className="-ml-2" variant="ghost">
        <Link href="/">← Bent Drive Copilot</Link>
      </Button>
      <Badge className="mt-10 block w-fit" variant="outline">
        Read-only pilot
      </Badge>
      <h1 className="mt-4 text-4xl font-semibold tracking-[-0.04em]">Connection guide</h1>
      <p className="mt-4 max-w-2xl leading-7 text-muted-foreground">
        Connect an approved MCP client to read your Tesla vehicle information.
        Sign in directly with Tesla. Your password stays with Tesla.
      </p>
      <Separator className="my-10" />

      <div className="grid gap-5">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>MCP endpoint</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <code className="block overflow-x-auto rounded-lg border bg-background p-4 font-mono text-sm text-foreground">
              https://drive.bent.build/mcp
            </code>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Authentication</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="leading-7 text-muted-foreground">
            <p>
              The service uses OAuth 2.1 authorization-code flow with PKCE and dynamic client
              registration. Sign in with Tesla to authorize vehicle access. Bent Drive Copilot issues
              separate, short-lived tokens to the MCP client.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Available tools</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground">
            <ul className="list-disc space-y-2 pl-5 leading-7">
              <li>
                <code className="text-foreground">tesla_list_vehicles</code> lists vehicles connected
                by the current user.
              </li>
              <li>
                <code className="text-foreground">tesla_get_vehicle_status</code> reads battery,
                range, charging, locks, climate and Sentry state.
              </li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Safety boundary</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="leading-7 text-muted-foreground">
            <p>
              The service requests only Tesla&apos;s vehicle-information scope. It does not request
              command scopes and cannot unlock, start, move or otherwise control a vehicle.
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
