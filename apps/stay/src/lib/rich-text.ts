import { z } from "zod";
import { localHomeControlsUrl } from "./home-control-link.ts";

export const guidePhotos = [
  {
    src: "/photos/kitchen-cupboards",
    alt: "Kitchen cupboards.",
    width: 1200,
    height: 900,
  },
  {
    src: "/photos/laundry",
    alt: "Laundry.",
    width: 900,
    height: 1200,
  },
  {
    src: "/photos/linen-cupboard",
    alt: "Linen cupboard.",
    width: 900,
    height: 1200,
  },
  {
    src: "/images/ikea-bilresa-remote.jpg",
    alt: "IKEA BILRESA dial remote",
    width: 800,
    height: 800,
  },
  {
    src: "/evacuation",
    alt: "Evacuation plan",
    width: 1600,
    height: 1200,
  },
];
export function isGuideLink(value: string): boolean {
  if (value === localHomeControlsUrl) return true;
  if (/^\/#?[a-z0-9/?=&-]*$/i.test(value)) return true;
  try {
    return ["https:", "tel:", "mailto:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
export function youtubeId(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    let id: string | null = null;
    if (host === "youtu.be") id = url.pathname.split("/")[1] ?? null;
    else if (
      [
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "www.youtube-nocookie.com",
      ].includes(host)
    )
      id =
        url.pathname === "/watch"
          ? url.searchParams.get("v")
          : /^\/(embed|shorts)\//.test(url.pathname)
            ? (url.pathname.split("/")[2] ?? null)
            : null;
    return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
type RichMark = {
  type: "bold" | "italic" | "strike" | "underline" | "code" | "link";
  attrs?: {
    href?: string;
    target?: string | null;
    rel?: string | null;
    class?: string | null;
    title?: string | null;
  };
};
export type RichNode = {
  type:
    | "doc"
    | "paragraph"
    | "text"
    | "heading"
    | "bulletList"
    | "orderedList"
    | "listItem"
    | "hardBreak"
    | "blockquote"
    | "horizontalRule"
    | "image"
    | "youtube";
  text?: string;
  content?: RichNode[];
  marks?: RichMark[];
  attrs?: {
    level?: number;
    start?: number;
    type?: string | null;
    src?: string;
    alt?: string | null;
    title?: string | null;
    width?: number | null;
    height?: number | null;
  };
};
export type RichDocument = { type: "doc"; content: RichNode[] };
const markSchema: z.ZodType<RichMark> = z
  .object({
    type: z.enum(["bold", "italic", "strike", "underline", "code", "link"]),
    attrs: z
      .object({
        href: z
          .string()
          .max(2000)
          .refine(
            isGuideLink,
            "Use a guide, home controls, https, telephone or email link.",
          )
          .optional(),
        target: z.string().max(30).nullable().optional(),
        rel: z.string().max(100).nullable().optional(),
        class: z.string().max(100).nullable().optional(),
        title: z.string().max(4000).nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((mark, ctx) => {
    if (mark.type === "link" && !mark.attrs?.href)
      ctx.addIssue({ code: "custom", message: "Links need an address." });
  });
const richNodeSchema: z.ZodType<RichNode> = z.lazy(() =>
  z
    .object({
      type: z.enum([
        "doc",
        "paragraph",
        "text",
        "heading",
        "bulletList",
        "orderedList",
        "listItem",
        "hardBreak",
        "blockquote",
        "horizontalRule",
        "image",
        "youtube",
      ]),
      text: z.string().max(20000).optional(),
      content: z.array(richNodeSchema).max(400).optional(),
      marks: z.array(markSchema).max(10).optional(),
      attrs: z
        .object({
          level: z.number().int().min(2).max(3).optional(),
          start: z.number().int().min(0).max(100000).optional(),
          type: z.string().max(20).nullable().optional(),
          src: z.string().max(2000).optional(),
          alt: z.string().max(4000).nullable().optional(),
          title: z.string().max(4000).nullable().optional(),
          width: z.number().positive().max(10000).nullable().optional(),
          height: z.number().positive().max(10000).nullable().optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .superRefine((node, ctx) => {
      if (
        node.type === "image" &&
        !guidePhotos.some((photo) => photo.src === node.attrs?.src)
      )
        ctx.addIssue({
          code: "custom",
          message: "Choose one of the apartment photos.",
        });
      if (node.type === "youtube" && !youtubeId(node.attrs?.src ?? ""))
        ctx.addIssue({
          code: "custom",
          message: "Enter a valid YouTube video link.",
        });
      if (node.type === "text" && !node.text)
        ctx.addIssue({ code: "custom", message: "Text cannot be empty." });
      if (node.type === "heading" && !node.attrs?.level)
        ctx.addIssue({ code: "custom", message: "Choose a heading size." });
    }),
);
export const richDocumentSchema: z.ZodType<RichDocument> = z
  .object({
    type: z.literal("doc"),
    content: z.array(richNodeSchema).min(1).max(400),
  })
  .strict()
  .superRefine((doc, ctx) => {
    let count = 0;
    function check(nodes: RichNode[], depth: number) {
      if (depth > 12) {
        ctx.addIssue({
          code: "custom",
          message: "The text has too many nested lists.",
        });
        return;
      }
      for (const node of nodes) {
        count++;
        if (node.content) check(node.content, depth + 1);
      }
    }
    check(doc.content, 0);
    if (count > 4000)
      ctx.addIssue({ code: "custom", message: "Please shorten this topic." });
  });
export function paragraph(text: string, bold = false): RichNode {
  return {
    type: "paragraph",
    content: text
      ? [{ type: "text", text, ...(bold ? { marks: [{ type: "bold" }] } : {}) }]
      : [],
  };
}
export function richText(body?: RichDocument): string {
  function visit(node: RichNode): string {
    return (
      node.text ??
      node.content
        ?.map(visit)
        .join(
          node.type === "paragraph" || node.type === "heading" ? "" : " ",
        ) ??
      ""
    );
  }
  return body?.content.map(visit).join("\n") ?? "";
}
