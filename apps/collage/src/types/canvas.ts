import { type ImageBackgroundType } from "@/app/_components/gradient-picker";
import { type api } from "@/trpc/server";

export type SerializedCanvasObject = Record<string, unknown>;

export interface SerializedCanvas {
  objects: SerializedCanvasObject[];
  background?: string;
  backgroundImage?: ImageBackgroundType;
  version?: string;
}

export type Collage = Awaited<ReturnType<typeof api.collage.getById>>;
