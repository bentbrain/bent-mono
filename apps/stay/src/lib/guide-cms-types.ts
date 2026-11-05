import { z } from "zod";
import { defaultGuideIntro } from "./guide-types.ts";
import { isGuideLink, richDocumentSchema } from "./rich-text.ts";

const text = z
  .string()
  .trim()
  .min(1, "Fill in empty fields or remove unused rows before saving.")
  .max(4000, "Please shorten text longer than 4,000 characters.");
const identifier = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(100);
const imageSchema = z
  .object({
    src: z.enum([
      "/evacuation",
      "/images/ikea-bilresa-remote.jpg",
      "/photos/kitchen-cupboards",
      "/photos/laundry",
      "/photos/linen-cupboard",
    ]),
    alt: text,
    width: z.number().int().positive().max(10000),
    height: z.number().int().positive().max(10000),
    displayWidth: z.number().int().positive().max(2000).optional(),
  })
  .strict();
const safeLink = z
  .string()
  .max(2000)
  .refine(
    isGuideLink,
    "Use a guide, home controls, https, telephone or email link.",
  );
const articleSchema = z
  .object({
    id: identifier,
    title: text,
    category: z.enum(["Arrival", "At home", "The building", "Help"]),
    summary: text,
    paragraphs: z.array(text).max(60),
    body: richDocumentSchema.optional(),
    steps: z.array(text).max(30).optional(),
    image: imageSchema.optional(),
    sections: z
      .array(
        z
          .object({
            id: identifier,
            title: text,
            description: text.optional(),
            items: z
              .array(z.object({ label: text, location: text }).strict())
              .max(50),
            image: imageSchema.optional(),
          })
          .strict(),
      )
      .max(12)
      .optional(),
    keywords: z.array(text).max(150),
    status: z.enum(["ready", "confirm"]),
    source: z
      .object({
        label: text,
        date: z
          .string()
          .regex(
            /^\d{4}-\d{2}-\d{2}$/,
            "Use YYYY-MM-DD for the source date, or leave it blank.",
          )
          .optional(),
      })
      .strict()
      .optional(),
    links: z
      .array(z.object({ label: text, href: safeLink }).strict())
      .max(20)
      .optional(),
  })
  .strict();
export const guideDocumentSchema = z
  .object({
    home: z
      .object({
        intro: z.string().trim().max(4000).default(defaultGuideIntro),
        name: text,
        host: text,
        hostPhone: text,
        hostEmail: z.email("Enter a valid email address."),
        wifiNetwork: text,
        neighbourhood: text,
        address: text,
        updated: text,
      })
      .strict(),
    articles: z.array(articleSchema).min(1).max(80),
    chatKnowledge: z
      .array(
        z
          .object({ articleId: identifier, facts: z.array(text).max(150) })
          .strict(),
      )
      .max(80),
  })
  .strict()
  .superRefine((document, context) => {
    const ids = new Set(document.articles.map((article) => article.id));
    if (ids.size !== document.articles.length)
      context.addIssue({
        code: "custom",
        message: "Topic identifiers must be unique.",
        path: ["articles"],
      });
    for (const [index, knowledge] of document.chatKnowledge.entries())
      if (!ids.has(knowledge.articleId))
        context.addIssue({
          code: "custom",
          message: "AI notes must belong to an existing topic.",
          path: ["chatKnowledge", index, "articleId"],
        });
  });
export type GuideDocument = z.infer<typeof guideDocumentSchema>;
export const guideStateSchema = z
  .object({
    version: z.literal(1),
    revision: z.string().min(1).max(100),
    published: guideDocumentSchema,
    draft: guideDocumentSchema,
    savedAt: z.string().nullable(),
    publishedAt: z.string().nullable(),
  })
  .strict();
export type GuideState = z.infer<typeof guideStateSchema>;
export const cmsSnapshotSchema = z.object({
  state: guideStateSchema,
  etag: z.string().nullable(),
  canSave: z.boolean(),
});
export type CmsSnapshot = z.infer<typeof cmsSnapshotSchema>;
export const cmsUpdateSchema = z
  .object({
    action: z.enum(["save", "publish"]),
    etag: z.string().nullable(),
    document: guideDocumentSchema,
  })
  .strict();
export type CmsAction = z.infer<typeof cmsUpdateSchema>["action"];

export function changeGuideState(
  previous: GuideState,
  document: GuideDocument,
  action: CmsAction,
  revision: string,
  timestamp: string,
): GuideState {
  return {
    version: 1,
    revision,
    published: action === "publish" ? document : previous.published,
    draft: document,
    savedAt: timestamp,
    publishedAt: action === "publish" ? timestamp : previous.publishedAt,
  };
}
