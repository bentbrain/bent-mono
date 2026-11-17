import { auth, clerkClient } from "@clerk/tanstack-react-start/server";
import { allowedEmails, configurationReady } from "./config";
export async function requireOwner() {
  if (!configurationReady())
    throw new Error(
      "Account services need configuration. Contact the app owner.",
    );
  const { userId } = await auth();
  if (!userId) throw new Error("Sign in to access your fitness data.");
  const user = await clerkClient().users.getUser(userId);
  const email = user.emailAddresses
    .find(
      (e) =>
        e.id === user.primaryEmailAddressId &&
        e.verification?.status === "verified",
    )
    ?.emailAddress.toLowerCase();
  if (!email || !allowedEmails().has(email))
    throw new Error("This account needs an invitation. Contact the app owner.");
  return userId;
}
