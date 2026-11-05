import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getGuideAccess } from "@/lib/session";
import { getCmsSnapshot } from "@/lib/guide-store";
import { GuideEditor } from "@/components/guide-editor";

export default async function EditPage() {
  await auth.protect();
  const access = await getGuideAccess();
  if (!access?.isHost) redirect("/");
  return <GuideEditor initial={await getCmsSnapshot()} />;
}
