import { type Media } from "@/payload-types";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function isMedia(
  image: (number | null) | Media | undefined,
): image is Media {
  if (typeof image === "number") {
    return false;
  }
  return typeof image === "object" && image !== null && "url" in image;
}
