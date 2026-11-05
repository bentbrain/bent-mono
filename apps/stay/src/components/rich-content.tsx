import Image from "next/image";
import type { ReactNode } from "react";
import { youtubeId, type RichDocument, type RichNode } from "@/lib/rich-text";

function NodeContent({ node }: { node: RichNode }) {
  const content = node.content?.map((child, index) => (
    <NodeContent key={index} node={child} />
  ));
  switch (node.type) {
    case "text": {
      let text: ReactNode = node.text;
      for (const mark of node.marks ?? []) {
        if (mark.type === "bold") text = <strong>{text}</strong>;
        else if (mark.type === "italic") text = <em>{text}</em>;
        else if (mark.type === "underline") text = <u>{text}</u>;
        else if (mark.type === "strike") text = <s>{text}</s>;
        else if (mark.type === "code") text = <code>{text}</code>;
        else if (mark.type === "link")
          text = (
            <a
              href={mark.attrs?.href}
              target={
                mark.attrs?.href?.startsWith("https:") ? "_blank" : undefined
              }
              rel="noopener noreferrer"
            >
              {text}
            </a>
          );
      }
      return text;
    }
    case "paragraph":
      return <p>{content?.length ? content : <br />}</p>;
    case "heading":
      return node.attrs?.level === 3 ? <h3>{content}</h3> : <h2>{content}</h2>;
    case "bulletList":
      return <ul>{content}</ul>;
    case "orderedList":
      return <ol start={node.attrs?.start ?? 1}>{content}</ol>;
    case "listItem":
      return <li>{content}</li>;
    case "hardBreak":
      return <br />;
    case "blockquote":
      return <blockquote>{content}</blockquote>;
    case "horizontalRule":
      return <hr />;
    case "image": {
      const src = node.attrs?.src;
      if (!src) return null;
      const alt = node.attrs?.alt ?? "Apartment photo";
      const figure = (
        <figure>
          <Image
            src={src}
            alt={alt}
            width={node.attrs?.width ?? 900}
            height={node.attrs?.height ?? 1200}
            className="h-auto max-w-full border"
            unoptimized
          />
          <figcaption className="mt-2 text-xs leading-6">{alt}</figcaption>
        </figure>
      );
      return src.startsWith("/photos/") ? (
        <details>
          <summary
            className="min-h-11 cursor-pointer text-xs"
            aria-label={`View ${alt}`}
          >
            view photo
          </summary>
          {figure}
        </details>
      ) : (
        figure
      );
    }
    case "youtube": {
      const id = youtubeId(node.attrs?.src ?? "");
      if (!id) return null;
      const query = new URLSearchParams({ rel: "0" });
      if (node.attrs?.start) query.set("start", String(node.attrs.start));
      return (
        <div className="aspect-video min-h-[200px] w-full border">
          <iframe
            className="h-full w-full"
            src={`https://www.youtube-nocookie.com/embed/${id}?${query}`}
            title="YouTube video"
            loading="lazy"
            referrerPolicy="strict-origin-when-cross-origin"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
          />
        </div>
      );
    }
    case "doc":
      return <>{content}</>;
  }
}
export function RichContent({ body }: { body: RichDocument }) {
  return (
    <div className="guide-prose">
      {body.content.map((node, index) => (
        <NodeContent key={index} node={node} />
      ))}
    </div>
  );
}
