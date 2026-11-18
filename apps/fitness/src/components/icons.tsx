import type { ReactNode } from "react";

const paths = {
  week: (
    <>
      <rect x="3.5" y="5" width="17" height="15" />
      <path d="M3.5 9.5h17M8 3v4M16 3v4M7 13h2M11 13h2M15 13h2M7 16.5h2" />
    </>
  ),
  exercises: (
    <>
      <path d="M2.5 9.5v5M5.5 7.5v9M18.5 7.5v9M21.5 9.5v5M5.5 12h13" />
    </>
  ),
  food: (
    <>
      <path d="M3.5 11h17a8.5 8.5 0 0 1-17 0Z" />
      <path d="M8 8c0-2 2-2 2-4M13 8c0-2 2-2 2-4" />
    </>
  ),
  progress: (
    <>
      <path d="M3.5 20.5h17" />
      <path d="M4 16l5-5 4 3 7-8" />
      <path d="M15 6h5v5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
    </>
  ),
  back: <path d="M15 5l-7 7 7 7" />,
  forward: <path d="M9 5l7 7-7 7" />,
  check: <path d="M4.5 12.5l5 5 10-11" />,
  play: <path d="M7 4.5v15l12-7.5Z" />,
  plus: <path d="M12 4v16M4 12h16" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.5v.5" />
    </>
  ),
  close: <path d="M5 5l14 14M19 5L5 19" />,
  run: (
    <>
      <circle cx="15" cy="4.5" r="2" />
      <path d="M5 21l4-6 3 2 1-5 4 3h3M9 11l3-3 4 1" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;

/** A decorative line icon. Pair it with visible text or an accessible name. */
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="square"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}
