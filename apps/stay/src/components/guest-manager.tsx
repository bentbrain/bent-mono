"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Mail, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { z } from "zod";
type Guest = { id: string; email: string };
export function GuestManager({
  invitations,
  guests,
}: {
  invitations: Guest[];
  guests: Guest[];
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  async function manage(
    body:
      | { action: "invite"; email: string }
      | { action: "revoke-invitation" | "revoke-guest"; id: string },
  ) {
    setPending(true);
    setMessage("");
    try {
      const response = await fetch("/api/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const parsed = z
          .object({ error: z.string() })
          .safeParse(await response.json());
        setMessage(
          parsed.success
            ? parsed.data.error
            : "Could not update guest access. Try again.",
        );
      } else {
        setMessage(
          body.action === "invite"
            ? "Invitation sent. It expires in 14 days."
            : "Access revoked.",
        );
        setEmail("");
        router.refresh();
      }
    } catch {
      setMessage("Could not connect. Please try again.");
    }
    setPending(false);
  }
  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-10">
      <Link
        href="/"
        className="inline-flex min-h-11 items-center gap-2 text-sm text-primary"
      >
        <ArrowLeft size={16} /> guide
      </Link>

      <h1 className="mt-6 text-2xl font-medium">guests</h1>
      <p className="mt-4 leading-7 text-muted-foreground">
        Invite guests by email.
      </p>
      <form
        className="my-8 rounded-2xl border bg-background p-5"
        onSubmit={(event) => {
          event.preventDefault();
          void manage({ action: "invite", email: email.trim() });
        }}
      >
        <label
          htmlFor="guest-email"
          className="mb-3 flex items-center gap-2 text-sm font-medium"
        >
          <Mail size={17} /> Guest email
        </label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Input
            id="guest-email"
            type="email"
            autoComplete="email"
            placeholder="guest@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            maxLength={254}
            className="h-12 text-base"
          />
          <Button type="submit" disabled={pending} className="h-12">
            <UserPlus size={17} /> Send invitation
          </Button>
        </div>
      </form>
      {message && (
        <p
          role="status"
          className="mb-6 rounded-xl bg-accent text-accent-foreground p-4 text-sm leading-6"
        >
          {message}
        </p>
      )}
      <section>
        <h2 className="mb-4 text-xl font-semibold">Pending invitations</h2>
        {invitations.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No pending invitations.
          </p>
        )}
        {invitations.map((guest) => (
          <div
            key={guest.id}
            className="flex flex-wrap items-center justify-between gap-3 border-b py-4"
          >
            <span className="break-all text-sm">{guest.email}</span>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() =>
                void manage({ action: "revoke-invitation", id: guest.id })
              }
            >
              Revoke invitation
            </Button>
          </div>
        ))}
      </section>
      <section className="mt-9">
        <h2 className="mb-4 text-xl font-semibold">Guests with access</h2>
        {guests.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Accepted invitations will appear here.
          </p>
        )}
        {guests.map((guest) => (
          <div
            key={guest.id}
            className="flex flex-wrap items-center justify-between gap-3 border-b py-4"
          >
            <span className="break-all text-sm">{guest.email}</span>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() =>
                void manage({ action: "revoke-guest", id: guest.id })
              }
            >
              Revoke access
            </Button>
          </div>
        ))}
      </section>
    </main>
  );
}
