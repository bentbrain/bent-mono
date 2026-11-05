import type { RichDocument } from "./rich-text";
export const defaultGuideIntro =
  "Use this guide to find things around the apartment and see how everything works. Search the topics below or ask AI a question.";
export type GuideCategory = "Arrival" | "At home" | "The building" | "Help";
export type GuideHome = {
  intro: string;
  name: string;
  host: string;
  hostPhone: string;
  hostEmail: string;
  wifiNetwork: string;
  neighbourhood: string;
  address: string;
  updated: string;
};
export type GuideImage = {
  src: string;
  alt: string;
  width: number;
  height: number;
  displayWidth?: number;
};
export type GuideKnowledge = {
  articleId: string;
  facts: string[];
};
export type GuideArticle = {
  id: string;
  title: string;
  category: GuideCategory;
  summary: string;
  paragraphs: string[];
  body?: RichDocument;
  steps?: string[];
  image?: GuideImage;
  sections?: {
    id: string;
    title: string;
    description?: string;
    items: { label: string; location: string }[];
    image?: GuideImage;
  }[];
  keywords: string[];
  status: "ready" | "confirm";
  source?: { label: string; date?: string };
  links?: { label: string; href: string }[];
};
