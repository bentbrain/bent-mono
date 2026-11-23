import type { ReactNode } from "react";
import type { AppId } from "@/lib/apps";
import { cn } from "@/lib/utils";

const glyphs: Record<AppId, ReactNode> = {
  fitness: (
    <path
      d="M8 7h2.7v8c1.3-1.6 3.1-2.5 5.3-2.5 4.4 0 7.5 3.2 7.5 7.6S20.4 27.8 16 27.8c-2.2 0-4-.9-5.3-2.5v2.1H8V7Zm7.8 8c-3 0-5.2 2.2-5.2 5s2.2 5 5.2 5 5-2.2 5-5-2-5-5-5Z"
      fill="currentColor"
    />
  ),
  trackmap: (
    <path
      d="M5 23 12 8l6 12 9-12-7 18Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    />
  ),
  shop: (
    <path
      d="M11.5 6 5 9.5l-2 5 4 1.8 1.8-3V26h14.4V13.3l1.8 3 4-1.8-2-5L20.5 6c-.7 1.8-2.5 3-4.5 3s-3.8-1.2-4.5-3Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    />
  ),
  home: (
    <g fill="currentColor">
      <path d="M16 4 4 10.5v11L16 28l12-6.5v-11L16 4Zm0 2.3 9.4 5.1L16 16.5l-9.4-5.1L16 6.3ZM6 13.1l9 4.9v7.5l-9-4.9v-7.5Zm11 12.4V18l9-4.9v7.5l-9 4.9Z" />
      <path d="M19 19.5l4-2.2v3.4l-4 2.2v-3.4Z" />
    </g>
  ),
  jp: (
    <g>
      <rect
        x="3"
        y="8"
        width="26"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <circle cx="16" cy="16" r="4.5" fill="currentColor" />
    </g>
  ),
  stay: (
    <path
      d="M5 15 16 5.5 27 15M8.5 12.5V26h15V12.5M13.5 26v-7.5h5V26"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    />
  ),
  drive: (
    <g fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="16" cy="16" r="11" />
      <circle cx="16" cy="16" r="2.5" />
      <path d="M5.5 13.5c3.2-.9 6.7-1.3 10.5-1.3s7.3.4 10.5 1.3M14 18l-3.5 8M18 18l3.5 8" />
    </g>
  ),
  toolbar: (
    <path
      d="M4 6h24v16H15l-7 5.5V22H4V6Zm4 5v2h16v-2H8Zm0 4v2h11v-2H8Z"
      fill="currentColor"
      fillRule="evenodd"
    />
  ),
  collage: (
    <g strokeWidth="2" stroke="currentColor">
      <path d="m5 9 13-3 2.5 11.5-13 3L5 9Z" fill="none" />
      <path d="M14 15h13v12H14V15Z" fill="currentColor" />
      <circle cx="10" cy="24" r="3" fill="none" />
    </g>
  ),
};

export function AppIcon({
  id,
  className,
}: Readonly<{ id: AppId; className?: string }>) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-grid shrink-0 place-items-center bg-cobalt text-white",
        className,
      )}
    >
      <svg viewBox="0 0 32 32" className="size-[58%]">
        {glyphs[id]}
      </svg>
    </span>
  );
}
