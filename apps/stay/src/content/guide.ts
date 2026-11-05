import "server-only";
import {
  defaultGuideIntro,
  type GuideArticle,
  type GuideHome,
  type GuideKnowledge,
} from "../lib/guide-types.ts";

// Synthetic local/preview content. Production content lives in private Blob storage.
export const home: GuideHome = {
  intro: defaultGuideIntro,
  name: "Example guest guide",
  host: "Example host",
  hostPhone: "+1 202 555 0100",
  hostEmail: "host@example.invalid",
  wifiNetwork: "Example guest network",
  neighbourhood: "Example neighbourhood",
  address: "Example address",
  updated: "2026-11-05",
};
export const articles: GuideArticle[] = [
  {
    id: "find-things",
    title: "Find things",
    category: "At home",
    summary: "Synthetic guide for local development.",
    paragraphs: [
      "Replace this fixture with your protected guide content before production.",
    ],
    sections: [
      {
        id: "example-storage",
        title: "Example storage",
        items: [{ label: "Example item", location: "Example location" }],
      },
    ],
    keywords: ["example", "storage"],
    status: "ready",
  },
];
export const chatKnowledge: GuideKnowledge[] = [
  {
    articleId: "find-things",
    facts: [
      "AI-only fixture note. This synthetic note is not rendered in the guest guide.",
    ],
  },
];
