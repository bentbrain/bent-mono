"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

interface RevokeInviteButtonProps {
  githubUsername: string;
  inviteId: string;
}

export function RevokeInviteButton({ githubUsername, inviteId }: RevokeInviteButtonProps) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" type="button" variant="destructive">
          Revoke
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke Tesla Bridge access?</AlertDialogTitle>
          <AlertDialogDescription>
            @{githubUsername} will no longer be able to connect, and their active MCP sessions will be
            revoked.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <form action={`/admin/invites/${inviteId}/revoke`} method="post">
            <AlertDialogAction type="submit" variant="destructive">
              Revoke access
            </AlertDialogAction>
          </form>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
