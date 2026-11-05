import "server-only";
import { currentUser } from "@clerk/nextjs/server";
import { cache } from "react";

export const getGuideAccess = cache(async () => {
  const user = await currentUser();
  if (!user) return null;
  const ownerEmail = process.env.OWNER_EMAIL?.toLowerCase();
  const isHost = Boolean(
    ownerEmail &&
    user.emailAddresses.some(
      (email) =>
        email.emailAddress.toLowerCase() === ownerEmail &&
        email.verification?.status === "verified",
    ),
  );
  if (isHost) return { userId: user.id, isHost: true };
  if (user.publicMetadata.guideAccess === "guest")
    return { userId: user.id, isHost: false };
  return null;
});
