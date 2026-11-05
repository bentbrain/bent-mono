import { UserButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { Effect, Either } from "effect";
import { redirect } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { listInvites } from "@/lib/db/store";
import { requireAdminIdentity } from "@/lib/identity";
import { runApp } from "@/lib/runtime";

import { RevokeInviteButton } from "./revoke-invite-button";

export default async function InvitesPage() {
  await auth.protect();
  const access = await runApp(Effect.either(requireAdminIdentity));
  if (Either.isLeft(access)) {
    redirect("/");
  }
  const invites = await runApp(listInvites);

  return (
    <main className="min-h-screen bg-background px-6 py-10 text-foreground">
      <div className="mx-auto max-w-5xl space-y-8">
        <header className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-primary">Bent Drive Copilot</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">Invite access</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Only GitHub users on this list can connect a Tesla account.
            </p>
          </div>
          <UserButton />
        </header>

        <Card>
          <CardHeader>
            <CardTitle>Invite a tester</CardTitle>
            <CardDescription>
              Re-inviting a GitHub username reactivates it and replaces its expiry date.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              action="/admin/invites/create"
              className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem_auto]"
              method="post"
            >
              <div className="grid gap-2">
                <Label htmlFor="githubUsername">GitHub username</Label>
                <Input
                  autoCapitalize="none"
                  autoComplete="username"
                  id="githubUsername"
                  name="githubUsername"
                  placeholder="octocat"
                  required
                  type="text"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="expiresInDays">Expires in days</Label>
                <Input
                  defaultValue="14"
                  id="expiresInDays"
                  max="365"
                  min="1"
                  name="expiresInDays"
                  required
                  type="number"
                />
              </div>
              <Button className="self-end" type="submit">
                Add invite
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Invited accounts</CardTitle>
            <CardDescription>
              Revoking access also revokes active MCP sessions for that account.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>GitHub user</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invites.length === 0 ? (
                  <TableRow>
                    <TableCell className="py-10 text-center text-muted-foreground" colSpan={4}>
                      No testers have been invited yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  invites.map((invite) => (
                    <TableRow key={invite.id}>
                      <TableCell className="font-medium">@{invite.githubUsername}</TableCell>
                      <TableCell>
                        <Badge variant={invite.status === "revoked" ? "outline" : "secondary"}>
                          {invite.status}
                        </Badge>
                      </TableCell>
                      <TableCell>{formatDate(invite.expiresAtEpoch)}</TableCell>
                      <TableCell className="text-right">
                        {invite.status === "revoked" ? null : (
                          <RevokeInviteButton
                            githubUsername={invite.githubUsername}
                            inviteId={invite.id}
                          />
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

function formatDate(epochSeconds: number): string {
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeZone: "Australia/Brisbane",
  }).format(new Date(epochSeconds * 1_000));
}
