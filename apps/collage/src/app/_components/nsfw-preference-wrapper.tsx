import { api } from "@/trpc/server";
import { auth } from "@clerk/nextjs/server";
import NSFWPreferenceDialog from "./nsfw-preference-dialog";

async function NsfwPreferenceWrapper() {
  const { userId } = await auth();

  if (!userId) return null;

  const hasPreferences = await api.user.getPreferences({ userId });

  return hasPreferences ? null : <NSFWPreferenceDialog userId={userId} />;
}

export default NsfwPreferenceWrapper;
