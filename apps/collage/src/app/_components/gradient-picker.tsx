"use client";

import { Button } from "@/app/_components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/app/_components/ui/popover";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/app/_components/ui/tabs";
import { cn } from "@/lib/utils";
import { type Background } from "@/payload-types";
import { Paintbrush } from "lucide-react";
import Image from "next/image";
import { useMemo } from "react";

const CURATED_IMAGE_BACKGROUNDS = [
  {
    src: "https://media.maya-collage.bent.build/payload/backgrounds/vintage-newsprint.webp",
    alt: "Aged vintage newsprint",
  },
  {
    src: "https://media.maya-collage.bent.build/payload/backgrounds/faded-hills.webp",
    alt: "Faded vintage rolling hills",
  },
  {
    src: "https://media.maya-collage.bent.build/payload/backgrounds/retro-floral-carpet.webp",
    alt: "Worn retro floral carpet",
  },
  {
    src: "https://media.maya-collage.bent.build/payload/backgrounds/vintage-paper-scraps.webp",
    alt: "Layered vintage paper scraps",
  },
] as const;

// Types for our background values.
export type GradientType = {
  type: "linear" | "radial" | "gradient";
  coords: { x1: number; y1: number; x2: number; y2: number };
  colorStops: { offset: number; color: string }[];
};

export type ImageBackgroundType = {
  type: "Image";
  src: string;
  options?: {
    width?: number;
    height?: number;
  };
};

export type BackgroundValue = string | GradientType | ImageBackgroundType;

/**
 * Convert our background value to a CSS string.
 * - If a string, just return it.
 * - If a gradient, reassemble a CSS linear-gradient string (using a default direction).
 * - If an image, return a CSS url().
 */
function backgroundToCss(bg: BackgroundValue): string {
  if (typeof bg === "string") return bg;
  if (bg.type === "linear" || bg.type === "radial" || bg.type === "gradient") {
    // Convert gradient object to CSS linear-gradient
    const colorStops = bg.colorStops
      .map((stop) => `${stop.color} ${stop.offset * 100}%`)
      .join(", ");
    return `linear-gradient(to right, ${colorStops})`;
  }
  if (bg.type === "Image") {
    return `url(${bg.src})`;
  }
  return "";
}

/**
 * Given a gradient string like
 * "linear-gradient(to top left, #accbee, #e7f0fd)"
 * extract the colors and return a gradient object.
 *
 * (Here we use default coordinates; you could add more logic to handle the direction.)
 */
function parseGradientString(gradientStr: string): GradientType {
  // Remove the "linear-gradient(" prefix and ")" suffix.
  const trimmed = gradientStr
    .replace(/^linear-gradient\(/, "")
    .replace(/\)$/, "");
  // Split into parts (the first part is the direction)
  const parts = trimmed.split(",").map((part) => part.trim());
  const colors = parts.slice(1); // ignore the direction
  return {
    type: "gradient",
    coords: { x1: 0, y1: 0, x2: 800, y2: 0 }, // default coords; you might adjust these
    colorStops: colors.map((color, index) => ({
      offset: index / (colors.length - 1),
      color,
    })),
  };
}

export function GradientPicker({
  background,
  setBackground,
  backgrounds,
  className,
}: {
  background: BackgroundValue;
  setBackground: (background: BackgroundValue) => void;
  backgrounds: Background;
  className?: string;
}) {
  const solids = [
    "#FFFFFF",
    "#E2E2E2",
    "#ff75c3",
    "#ffa647",
    "#ffe83f",
    "#9fff5b",
    "#70e2ff",
    "#cd93ff",
    "#09203f",
  ];

  // Note: We now keep an array of CSS gradient strings.
  const gradientStrings = [
    "linear-gradient(to top left, #accbee, #e7f0fd)",
    "linear-gradient(to top left, #d5d4d0, #eeeeec)",
    "linear-gradient(to top left, #000000, #434343)",
    "linear-gradient(to top left, #09203f, #537895)",
    "linear-gradient(to top left, #AC32E4, #7918F2, #4801FF)",
    "linear-gradient(to top left, #f953c6, #b91d73)",
    "linear-gradient(to top left, #ee0979, #ff6a00)",
    "linear-gradient(to top left, #F00000, #DC281E)",
    "linear-gradient(to top left, #00c6ff, #0072ff)",
    "linear-gradient(to top left, #4facfe, #00f2fe)",
    "linear-gradient(to top left, #0ba360, #3cba92)",
    "linear-gradient(to top left, #FDFC47, #24FE41)",
    "linear-gradient(to top left, #8a2be2, #0000cd, #228b22, #ccff00)",
    "linear-gradient(to top left, #40E0D0, #FF8C00, #FF0080)",
    "linear-gradient(to top left, #fcc5e4, #fda34b, #ff7882, #c8699e, #7046aa, #0c1db8, #020f75)",
    "linear-gradient(to top left, #ff75c3, #ffa647, #ffe83f, #9fff5b, #70e2ff, #cd93ff)",
  ];

  const images = [
    ...CURATED_IMAGE_BACKGROUNDS,
    ...(backgrounds.backgrounds ?? []).flatMap((background) => {
      if (typeof background.image === "number" || !background.image?.url) {
        return [];
      }
      return [
        {
          src: background.image.url,
          alt: background.image.alt || "Collage background",
        },
      ];
    }),
  ];

  // Determine which tab to default to based on the background type.
  const defaultTab = useMemo(() => {
    if (typeof background === "object") {
      if (background.type === "Image") return "image";
      if (
        background.type === "gradient" ||
        background.type === "linear" ||
        background.type === "radial"
      )
        return "gradient";
    }
    return "solid";
  }, [background]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          data-joyride="background-picker"
          variant={"outline"}
          className={cn(
            "md:w-max md:justify-start md:text-left",
            !background && "text-muted-foreground",
            className,
          )}
        >
          <div className="flex items-center gap-2 md:w-full md:justify-start">
            Background
            {background ? (
              <div
                className="h-4 w-4 rounded border border-black !bg-cover !bg-center transition-all"
                style={{ background: backgroundToCss(background) }}
              ></div>
            ) : (
              <Paintbrush className="h-4 w-4" />
            )}
          </div>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="rounded-sm border-4 border-black bg-stone-100 shadow-[5px_5px_0_0_rgba(0,0,0,0.5)]">
        <Tabs defaultValue={defaultTab} className="w-full">
          <TabsList className="mb-4 h-auto w-full p-0">
            <TabsTrigger className="flex-1" value="solid">
              Solid
            </TabsTrigger>
            <TabsTrigger className="flex-1" value="gradient">
              Gradient
            </TabsTrigger>
            <TabsTrigger className="flex-1" value="image">
              Image
            </TabsTrigger>
          </TabsList>

          <TabsContent value="solid" className="mt-0 flex flex-wrap gap-1">
            {solids.map((s) => (
              <div
                key={s}
                style={{ background: s }}
                className="h-6 w-6 cursor-pointer rounded-md border border-stone-600 active:scale-105"
                onClick={() => setBackground(s)}
              />
            ))}
          </TabsContent>

          <TabsContent value="gradient" className="mt-0">
            <div className="mb-2 flex flex-wrap gap-1">
              {gradientStrings.map((g) => (
                <div
                  key={g}
                  style={{ background: g }}
                  className="h-6 w-6 cursor-pointer rounded-md border border-stone-600 active:scale-105"
                  onClick={() => {
                    const gradientObj = parseGradientString(g);
                    setBackground(gradientObj);
                  }}
                />
              ))}
            </div>
          </TabsContent>

          <TabsContent value="image" className="mt-0">
            <div className="mb-2 grid grid-cols-2 gap-1">
              {images.map(({ src, alt }) => (
                <div key={src} className="relative h-12 w-full">
                  <Image
                    src={src}
                    alt={alt}
                    fill={true}
                    onClick={() =>
                      setBackground({ type: "Image", src, options: {} })
                    }
                    sizes="120px"
                    className="h-12 w-full cursor-pointer rounded-md border border-stone-600 object-cover active:scale-105"
                  />
                </div>
              ))}
            </div>
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}
