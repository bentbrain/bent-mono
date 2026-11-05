"use client";
import { Button } from "@/app/_components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/app/_components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/app/_components/ui/popover";
import { cn, isMedia } from "@/lib/utils";
import { type Category } from "@/payload-types";
import { Cherry, Images } from "lucide-react";
import Image from "next/image";
import { useEffect, useState } from "react";
import { Input } from "./ui/input";
import { ScrollArea } from "./ui/scroll-area";
import { Tabs, TabsContent } from "./ui/tabs";

type Props = {
  categories: Category[];
  isMobile: boolean;
  onImageClick?: (imageData: {
    url: string;
    alt?: string;
    isNsfw?: boolean;
  }) => void;
  setStickersOpen?: React.Dispatch<React.SetStateAction<boolean>>;
};

function CanvasGalleries({
  categories,
  onImageClick,
  isMobile,
  setStickersOpen,
}: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState<string>(() => {
    // Try to get the saved search term from localStorage
    if (typeof window !== "undefined") {
      const savedSearch = localStorage.getItem("selectedCategorySearch");
      return savedSearch ?? "";
    }
    return "";
  });
  const [selectedCategory, setSelectedCategory] = useState<
    Category["name"] | undefined
  >(() => {
    // Try to get the saved category from localStorage
    if (typeof window !== "undefined") {
      const savedCategory = localStorage.getItem("selectedCategory");
      // Check if the saved category exists in the available categories
      if (
        savedCategory &&
        categories.some((cat) => cat.name === savedCategory)
      ) {
        return savedCategory;
      }
    }
    return categories[0]?.name ?? undefined;
  });

  const [selectedCategoryNsfw, setSelectedCategoryNsfw] = useState<
    boolean | undefined
  >(() => {
    if (typeof window !== "undefined") {
      const savedCategory = localStorage.getItem("selectedCategory");
      if (savedCategory) {
        const category = categories.find((cat) => cat.name === savedCategory);
        return category?.images?.some((image) => image.isNsfw) ?? undefined;
      }
    }
    return categories[0]?.images?.[0]?.isNsfw ?? undefined;
  });

  // Save selected category to localStorage whenever it changes
  useEffect(() => {
    if (typeof window !== "undefined" && selectedCategory) {
      localStorage.setItem("selectedCategory", selectedCategory);
    }
  }, [selectedCategory]);

  // Save search term to localStorage whenever it changes
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("selectedCategorySearch", search);
    }
  }, [search]);

  const showSearch = categories
    .find((category) => category.name === selectedCategory)
    ?.images?.some((image) => Boolean(image.tags?.length));

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            id="category-select"
            aria-expanded={open}
            className="h-auto w-full justify-between rounded-none border-0 border-b-4 border-black shadow-none hover:translate-x-[0px] hover:translate-y-[0px]"
          >
            <div className="flex flex-col items-start">
              <span className="text-xs text-stone-500">Stickers:</span>
              <span className="flex items-center justify-between gap-1">
                {selectedCategory ?? "Select category..."}{" "}
                {selectedCategoryNsfw && <Cherry className="text-red-500" />}
              </span>
            </div>
            <Images className="ml-2 h-4 w-4 shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[300px] p-0">
          <Command>
            <CommandList>
              <CommandEmpty>No categories found.</CommandEmpty>
              <CommandGroup>
                {categories.map((category) => {
                  const hasNsfw = category.images?.some(
                    (image) => image.isNsfw,
                  );

                  return (
                    <CommandItem
                      key={category.name}
                      value={category.name ?? ""}
                      className={cn(
                        "inline-flex w-full items-center justify-between",
                        category.name === selectedCategory && "bg-stone-100",
                      )}
                      onSelect={(currentValue) => {
                        setSelectedCategory(currentValue);
                        setSelectedCategoryNsfw(hasNsfw);
                        setOpen(false);
                      }}
                    >
                      <span>{category.name} </span>
                      {hasNsfw && (
                        <span className="inline-flex gap-1 text-xs text-red-500">
                          <Cherry />
                          NSFW
                        </span>
                      )}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {showSearch && (
        <Input
          placeholder="Search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="rounded-none border-0 border-b-4 border-black"
        />
      )}
      <Tabs
        onValueChange={setSelectedCategory}
        defaultValue={selectedCategory ?? ""}
        value={selectedCategory ?? ""}
        className="flex min-h-0 flex-1 flex-col"
      >
        {categories.map((category) => {
          const hasTags = category.images?.some(
            (image) => image.tags?.length && image.tags.length > 0,
          );

          return (
            <TabsContent
              className="mt-0 min-h-0 flex-1 overflow-hidden data-[state='inactive']:hidden"
              key={category.name}
              value={category.name ?? ""}
            >
              <ScrollArea className="h-full">
                <div className="grid grid-cols-2 place-items-center gap-2 p-2">
                  {(() => {
                    const lowerSearch = search.trim().toLowerCase();
                    // Combine filtering and computing minimum index into one pass.
                    const filteredSortedImages = category.images
                      ?.filter((image) => isMedia(image.image))
                      .reduce(
                        (acc, image) => {
                          // If there's no search text or if the image's tags don't matter,
                          // assign a default index which preserves the natural order.
                          if (!hasTags || lowerSearch === "") {
                            acc.push({ image, minIndex: 0 });
                          } else {
                            let minIndex = Infinity;
                            // Loop over each tag, breaking early if a tag is found at index 0.
                            for (const tagObj of image.tags ?? []) {
                              const tagVal = tagObj.tag?.toLowerCase();
                              if (tagVal) {
                                const idx = lowerSearch.indexOf(tagVal);
                                if (idx !== -1 && idx < minIndex) {
                                  minIndex = idx;
                                  if (minIndex === 0) break;
                                }
                              }
                            }
                            // Only include the image if at least one tag was found in the search.
                            if (minIndex !== Infinity) {
                              acc.push({ image, minIndex });
                            }
                          }
                          return acc;
                        },
                        [] as Array<{
                          image: (typeof category.images)[number];
                          minIndex: number;
                        }>,
                      )
                      .sort((a, b) => a.minIndex - b.minIndex)
                      .map(({ image }) => image);

                    return filteredSortedImages?.map((image) => {
                      if (!isMedia(image.image)) {
                        return null;
                      }
                      const imageData = {
                        url: image.image.url ?? "",
                        alt: image.image.alt ?? "",
                        isNsfw: image.isNsfw ?? false,
                      };
                      return (
                        <div
                          key={image.id}
                          draggable="true"
                          data-joyride={"draggable-image"}
                          onDragStart={(e) => {
                            e.dataTransfer.setData(
                              "text/plain",
                              JSON.stringify(imageData),
                            );
                            e.dataTransfer.effectAllowed = "copy";
                          }}
                          onClick={() => {
                            if (isMobile) {
                              setStickersOpen?.(false);
                            }
                            onImageClick?.(imageData);
                          }}
                        >
                          <Image
                            loading="lazy"
                            crossOrigin="anonymous"
                            width={100}
                            height={100}
                            className="aspect-square object-contain"
                            style={{ objectFit: "contain" }}
                            sizes="100px"
                            quality={60}
                            src={image.image.url ?? ""}
                            alt={image.image.alt ?? ""}
                          />
                        </div>
                      );
                    });
                  })()}
                </div>
              </ScrollArea>
            </TabsContent>
          );
        })}
      </Tabs>
    </div>
  );
}

export default CanvasGalleries;
