import { WifiDetails } from "@/components/wifi-access";
import { RichContent } from "@/components/rich-content";
import { legacyBody } from "@/lib/guide-migration";
import type { GuideArticle } from "@/lib/guide-types";

export function ArticleContent({
  article,
  wifiPassword = null,
  wifiNetwork = "",
}: {
  article: GuideArticle;
  wifiPassword?: string | null;
  wifiNetwork?: string;
}) {
  return (
    <>
      <RichContent body={article.body ?? legacyBody(article)} />
      {article.id === "wifi" && wifiPassword !== null && (
        <WifiDetails password={wifiPassword} network={wifiNetwork} />
      )}
    </>
  );
}
