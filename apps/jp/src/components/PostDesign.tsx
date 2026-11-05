import {
  shopDesignImage,
  shopDesignLink,
  type ShopDesign,
} from '../lib/shop-design';

export function PostDesign({ design }: { design: ShopDesign }) {
  return (
    <div
      className="post-design flex flex-col overflow-hidden border bg-white"
      data-feedback-id="post-design"
    >
      <div className="min-h-0 flex-1 p-4">
        <img
          src={shopDesignImage(design)}
          alt={`Flat ${design.color} t-shirt with the post's bent design`}
          width="768"
          height="768"
          loading="lazy"
          draggable={false}
          className="mx-auto aspect-square h-auto w-full max-w-[420px] object-contain"
        />
      </div>
      <a
        href={shopDesignLink(design)}
        className="post-design-link flex shrink-0 flex-wrap items-center justify-between gap-2 border-t bg-background p-3 text-foreground no-underline hover:bg-primary hover:text-primary-foreground"
        target="_blank"
        rel="noopener"
        aria-label={`Shop this design on a ${design.color} t-shirt`}
        draggable={false}
      >
        <span>shop.bent.build</span>
        <span>SHOP DESIGN ↗</span>
      </a>
    </div>
  );
}
