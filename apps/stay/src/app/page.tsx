import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getGuideAccess } from "@/lib/session";
import { getGuideDocument } from "@/lib/guide-store";
import { Guide } from "@/components/guide";
export default async function Page() {
  await auth.protect();
  const access = await getGuideAccess();
  if (!access) redirect("/access");
  const { articles, home } = await getGuideDocument();
  return (
    <Guide
      articles={articles
        .filter((article) => article.status === "ready")
        .map((article) => ({
          id: article.id,
          title: article.title,
          category: article.category,
          summary: article.summary,
          body: article.body,
          paragraphs: [],
          keywords: article.keywords,
          status: article.status,
        }))}
      home={home}
      isHost={access.isHost}
      setupTopics={
        access.isHost
          ? articles
              .filter((article) => article.status === "confirm")
              .map((article) => article.title)
          : []
      }
    />
  );
}
