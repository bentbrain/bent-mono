import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

export default function TermsPage() {
  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-16 sm:px-10">
      <Button asChild className="-ml-2" variant="ghost">
        <Link href="/">← Bent Drive Copilot</Link>
      </Button>
      <h1 className="mt-10 text-4xl font-semibold tracking-[-0.04em]">Pilot terms</h1>
      <Separator className="my-8" />
      <Card>
        <CardContent className="space-y-5 py-2 leading-7 text-muted-foreground">
          <p>
            Bent Drive Copilot is an early read-only service provided for invited testing. Vehicle
            data may be delayed, incomplete or unavailable.
          </p>
          <p>
            Do not rely on the service for emergencies, safety-critical decisions, charging
            availability or proof that a vehicle is secure.
          </p>
          <p>
            The service is not affiliated with or endorsed by Tesla, Inc. Tesla account access
            remains governed by Tesla&apos;s terms and can be revoked from your Tesla account.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
