import type { GuideArticle, GuideImage } from "./guide-types.ts";
import type { GuideDocument, GuideState } from "./guide-cms-types.ts";
import {
  paragraph,
  youtubeId,
  type RichDocument,
  type RichNode,
} from "./rich-text.ts";

function heading(text: string): RichNode {
  return {
    type: "heading",
    attrs: { level: 2 },
    content: [{ type: "text", text }],
  };
}
function photo(image: GuideImage): RichNode {
  return {
    type: "image",
    attrs: {
      src: image.src,
      alt: image.alt,
      width: image.displayWidth ?? image.width,
      height: image.height,
    },
  };
}
export function legacyBody(article: GuideArticle): RichDocument {
  if (article.body) return article.body;
  const content: RichNode[] = article.paragraphs.map((text) => paragraph(text));
  for (const section of article.sections ?? []) {
    content.push(heading(section.title));
    if (section.description) content.push(paragraph(section.description));
    for (const item of section.items)
      content.push({
        type: "paragraph",
        content: [
          { type: "text", text: item.label, marks: [{ type: "bold" }] },
          { type: "hardBreak" },
          { type: "text", text: item.location },
        ],
      });
    if (section.image) content.push(photo(section.image));
  }
  if (article.steps?.length)
    content.push({
      type: "orderedList",
      attrs: { start: 1 },
      content: article.steps.map((text) => ({
        type: "listItem",
        content: [paragraph(text)],
      })),
    });
  if (article.image) content.push(photo(article.image));
  for (const link of article.links ?? []) {
    if (youtubeId(link.href))
      content.push(paragraph(link.label, true), {
        type: "youtube",
        attrs: { src: link.href, width: 640, height: 360, start: 0 },
      });
    else
      content.push({
        type: "paragraph",
        content: [
          {
            type: "text",
            text: link.label,
            marks: [{ type: "link", attrs: { href: link.href } }],
          },
        ],
      });
  }
  return { type: "doc", content: content.length ? content : [paragraph("")] };
}
function withBody(
  article: GuideDocument["articles"][number],
  body: RichDocument,
): GuideDocument["articles"][number] {
  return {
    ...article,
    body,
    paragraphs: [],
    steps: undefined,
    sections: undefined,
    image: undefined,
    links: undefined,
  };
}
export function upgradeGuideDocument(document: GuideDocument): GuideDocument {
  return {
    ...document,
    articles: document.articles.map((article) =>
      article.body ? article : withBody(article, legacyBody(article)),
    ),
  };
}
export function upgradeGuideState(state: GuideState): GuideState {
  return {
    ...state,
    published: upgradeGuideDocument(state.published),
    draft: upgradeGuideDocument(state.draft),
  };
}
