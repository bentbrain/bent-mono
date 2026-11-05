import { clerkClient } from "@clerk/nextjs/server";
import { z } from "zod";
import { getGuideAccess } from "@/lib/session";
import { allowRequest, sameOrigin } from "@/lib/request-guards";
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("invite"), email: z.email().max(254) }),
  z.object({
    action: z.literal("revoke-invitation"),
    id: z.string().regex(/^inv_[a-zA-Z0-9]+$/),
  }),
  z.object({
    action: z.literal("revoke-guest"),
    id: z.string().regex(/^user_[a-zA-Z0-9]+$/),
  }),
]);
export async function POST(request: Request) {
  if (!sameOrigin(request))
    return Response.json({ error: "Request not allowed." }, { status: 403 });
  const access = await getGuideAccess();
  if (!access?.isHost)
    return Response.json(
      { error: "Only the host can manage guests." },
      { status: 403 },
    );
  if (!allowRequest(`invite:${access.userId}`, 30, 3600_000))
    return Response.json(
      { error: "Please try again in an hour." },
      { status: 429 },
    );
  const text = await request.text();
  if (text.length > 2000)
    return Response.json({ error: "Request too large." }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    return Response.json(
      { error: "Check the email address and try again." },
      { status: 400 },
    );
  const client = await clerkClient();
  try {
    if (parsed.data.action === "invite") {
      await client.invitations.createInvitation({
        emailAddress: parsed.data.email.toLowerCase(),
        redirectUrl: `${process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin}/sign-up`,
        publicMetadata: { guideAccess: "guest" },
        expiresInDays: 14,
      });
    } else if (parsed.data.action === "revoke-invitation") {
      await client.invitations.revokeInvitation(parsed.data.id);
    } else {
      if (parsed.data.id === access.userId)
        return Response.json(
          { error: "You cannot revoke your own host access." },
          { status: 400 },
        );
      const target = await client.users.getUser(parsed.data.id);
      if (target.publicMetadata.guideAccess !== "guest")
        return Response.json(
          { error: "This account is not an active guest." },
          { status: 400 },
        );
      await client.users.updateUserMetadata(parsed.data.id, {
        publicMetadata: { guideAccess: "revoked" },
      });
    }
    return Response.json({ ok: true });
  } catch {
    return Response.json(
      {
        error:
          "Clerk could not complete that request. The email may already have an account or a pending invitation. Check the guest list and try again.",
      },
      { status: 409 },
    );
  }
}
