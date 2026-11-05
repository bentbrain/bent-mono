import { notFound } from "next/navigation";
import { clerkClient } from "@clerk/nextjs/server";
import { getGuideAccess } from "@/lib/session";
import { GuestManager } from "@/components/guest-manager";
export default async function GuestsPage() {
  const access = await getGuideAccess();
  if (!access?.isHost) notFound();
  const client = await clerkClient();
  const [invitations, users] = await Promise.all([
    client.invitations.getInvitationList({ status: "pending", limit: 100 }),
    client.users.getUserList({ limit: 100 }),
  ]);
  return (
    <GuestManager
      invitations={invitations.data.map((invitation) => ({
        id: invitation.id,
        email: invitation.emailAddress,
      }))}
      guests={users.data
        .filter((user) => user.publicMetadata.guideAccess === "guest")
        .map((user) => ({
          id: user.id,
          email: user.primaryEmailAddress?.emailAddress || "Guest",
        }))}
    />
  );
}
