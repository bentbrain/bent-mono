import Image, { type StaticImageData } from "next/image";
import { cn } from "@/lib/utils";

type FrameProps = Readonly<{
  image: StaticImageData;
  alt: string;
  priority?: boolean;
}>;

export function BrowserFrame({
  image,
  alt,
  domain,
  priority,
}: FrameProps & Readonly<{ domain: string }>) {
  return (
    <figure className="w-[min(82vw,46rem)] shrink-0 snap-start border border-border bg-background shadow-[0_24px_60px_-32px_rgb(0_0_0/0.35)] dark:shadow-none">
      <div className="flex h-8 items-center gap-3 border-b border-border px-3">
        <span aria-hidden="true" className="flex gap-1.5">
          <span className="size-2.5 bg-muted-foreground/30" />
          <span className="size-2.5 bg-muted-foreground/30" />
          <span className="size-2.5 bg-muted-foreground/30" />
        </span>
        <span className="mx-auto truncate font-mono text-[11px] text-muted-foreground">
          {domain}
        </span>
        <span aria-hidden="true" className="w-[3.25rem]" />
      </div>
      <Image
        src={image}
        alt={alt}
        placeholder="blur"
        priority={priority}
        sizes="(min-width: 768px) 46rem, 82vw"
        className="block h-auto w-full"
      />
    </figure>
  );
}

export function PhoneFrame({
  image,
  alt,
  priority,
  className,
  sizes = "(min-width: 768px) 15rem, 52vw",
}: FrameProps & Readonly<{ className?: string; sizes?: string }>) {
  return (
    <figure
      className={cn(
        "w-[min(52vw,15rem)] shrink-0 snap-start rounded-[2.25rem] bg-neutral-950 p-2 shadow-[0_24px_60px_-32px_rgb(0_0_0/0.45)] ring-1 ring-neutral-800 dark:ring-neutral-700",
        className,
      )}
    >
      <div className="overflow-hidden rounded-[1.75rem] bg-white">
        <div
          aria-hidden="true"
          className="flex h-7 items-center justify-center"
        >
          <span className="h-4 w-16 rounded-full bg-neutral-950" />
        </div>
        <Image
          src={image}
          alt={alt}
          placeholder="blur"
          priority={priority}
          sizes={sizes}
          className="block h-auto w-full"
        />
      </div>
    </figure>
  );
}
