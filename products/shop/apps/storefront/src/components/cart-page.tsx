"use client";

import { formatMoney } from "@shopify/hydrogen";
import {
  ChevronDownIcon,
  LoaderCircleIcon,
  MinusIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";

import { useState, type ComponentProps } from "react";

import {
  useProductPurchaseReadiness,
  useProductsPurchaseReadiness,
} from "@/client/use-product-purchase-readiness";
import { captureStorefrontAction } from "@/client/posthog";

import { CartGarmentMockup } from "@/components/cart-garment-mockup";
import { CartVariantSelectors } from "@/components/cart-variant-selectors";
import { DialogClose } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useCart, useCartForm } from "@/lib/cart";
import { storefrontProductTitle } from "@/lib/storefront-brand";
import {
  freeDeliveryRemaining,
  STANDARD_DELIVERY_FEE_MONEY_AUD,
} from "@/lib/shipping-policy";
import { cn } from "@/lib/utils";

type CartLayout = "overlay" | "page";

interface CartLineAttribute {
  key: string;
  value: string | null;
}

interface CartSelectedOption {
  name: string;
  value: string;
}

type CartVariantNodes = ComponentProps<typeof CartVariantSelectors>["variants"];

function cartLineAttributes(
  attributes: CartLineAttribute[] | null | undefined,
) {
  return attributes ?? [];
}

function cartProductVariants(product: {
  variants?: { nodes: CartVariantNodes };
}) {
  return product.variants?.nodes;
}

export function CartPage({ initialError }: { initialError?: string }) {
  return (
    <main className="flex-1 bg-background px-[clamp(1rem,4vw,4rem)] pt-4 pb-20 text-primary">
      <div className="mx-auto mt-[clamp(4rem,10vh,8rem)] max-w-[900px]">
        <h1 className="mt-2 text-[clamp(3rem,8vw,7rem)] leading-[0.9] tracking-[-0.07em]">
          Cart
        </h1>
        {initialError ? (
          <p className="mt-6 border border-primary p-4 text-sm" role="alert">
            {initialError}
          </p>
        ) : null}
        <CartContents layout="page" />
      </div>
    </main>
  );
}

export function CartContents({ layout }: { layout: CartLayout }) {
  return <CartContent layout={layout} />;
}

function CartContent({ layout }: { layout: CartLayout }) {
  const cart = useCart((state) => state.data);
  const pending = useCart((state) => state.pending);
  const errors = useCart((state) => state.errors);
  const { formProps, register } = useCartForm();
  const lines = cart.lines.nodes.filter(({ quantity }) => quantity > 0);
  lines.sort(
    (left, right) =>
      Number(right.id.startsWith("optimistic:")) -
      Number(left.id.startsWith("optimistic:")),
  );
  const preparingProductIds = lines.flatMap((line) => {
    const attributes = cartLineAttributes(line.attributes);
    const pendingArtwork = attributes.some(
      ({ key, value }) => key === "_lineCapability" && value?.startsWith("i1."),
    );
    const productId = attributes.find(({ key }) => key === "_productId")?.value;
    return pendingArtwork && productId ? [productId] : [];
  });
  const hasLines = lines.length > 0;
  const isUpdating = pending.lines.size > 0;
  const remainingForFreeDelivery = freeDeliveryRemaining(
    cart.cost.subtotalAmount,
  );

  if (!hasLines) {
    const createLink = (
      <a
        className="mt-6 grid min-h-14 w-full place-items-center border border-primary bg-primary text-xs font-bold tracking-[0.08em] text-primary-foreground uppercase"
        href="/create"
      >
        Make your own
      </a>
    );
    return (
      <div
        className={cn(
          layout === "overlay"
            ? "grid min-h-0 flex-1 content-center p-6 text-center"
            : "mt-12",
        )}
      >
        <p>Your cart is empty.</p>
        {layout === "overlay" ? (
          <DialogClose asChild>{createLink}</DialogClose>
        ) : (
          createLink
        )}
      </div>
    );
  }

  return (
    <div className={cn(layout === "overlay" && "flex min-h-0 flex-1 flex-col")}>
      <div
        className={cn(
          layout === "overlay"
            ? "min-h-0 flex-1 overflow-y-auto px-4 [&>article:last-child]:border-b-0"
            : "mt-12 border-t border-primary",
        )}
        data-cart-lines
      >
        {lines.map((line) => {
          const title = storefrontProductTitle(line.merchandise.product.title);
          const productImage = line.merchandise.image;
          const attributes = cartLineAttributes(line.attributes);
          const productId = attributes.find(
            ({ key }) => key === "_productId",
          )?.value;
          const selectedOptions = line.merchandise.selectedOptions;
          const productVariants = cartProductVariants(line.merchandise.product);
          const selectedColor =
            selectedOptions.find(
              (option) => option.name.toLowerCase() === "color",
            )?.value ?? "White";
          const lineErrors = errors.lines.get(line.id);
          const linePending = pending.lines.has(line.id);
          const lineOptimistic = line.id.startsWith("optimistic:");
          const formId = `cart-line-${encodeURIComponent(line.id)}`;
          const errorId = `${formId}-errors`;
          const removeButtonProps = register("remove");

          return (
            <article
              aria-label={title}
              key={line.id}
              className={cn(
                "grid grid-cols-[88px_minmax(0,1fr)] gap-4 border-b border-primary py-5",
                layout === "page" &&
                  "sm:grid-cols-[112px_minmax(0,1fr)_auto] sm:items-center sm:gap-6",
              )}
            >
              {productId ? (
                <CartGarmentMockup
                  color={selectedColor}
                  productId={productId}
                  preparationRevision={
                    attributes.some(
                      ({ key, value }) =>
                        key === "_lineCapability" && value?.startsWith("i1."),
                    )
                      ? (attributes.find(({ key }) => key === "_designId")
                          ?.value ?? undefined)
                      : undefined
                  }
                  sizes={layout === "overlay" ? "88px" : "112px"}
                  title={title}
                />
              ) : (
                <div className="relative aspect-square overflow-hidden border border-primary bg-primary/5">
                  {productImage ? (
                    <img
                      data-fill="true"
                      src={productImage.url}
                      alt={productImage.altText ?? `${title} product image`}
                      sizes={layout === "overlay" ? "88px" : "112px"}
                      className="object-contain"
                    />
                  ) : (
                    <div
                      className="grid h-full place-items-center px-2 text-center text-[0.6rem]"
                      aria-hidden="true"
                    >
                      bent.shop
                    </div>
                  )}
                </div>
              )}

              <div className="flex min-w-0 flex-col" data-cart-line-details>
                <form
                  className="flex flex-1 flex-col"
                  id={formId}
                  {...formProps()}
                >
                  <button
                    className="hidden"
                    {...register("set")}
                    aria-hidden="true"
                  />
                  <input
                    type="hidden"
                    {...register("lineId", { value: line.id })}
                  />

                  <div
                    className="flex min-w-0 items-end gap-2"
                    data-cart-line-options
                  >
                    {productVariants && !lineOptimistic ? (
                      <CartVariantSelectors
                        key={line.merchandise.id}
                        attributes={attributes}
                        lineId={line.id}
                        merchandiseId={line.merchandise.id}
                        options={line.merchandise.product.options}
                        quantity={line.quantity}
                        selectedOptions={selectedOptions}
                        title={title}
                        variants={productVariants}
                        pending={linePending}
                      />
                    ) : lineOptimistic ? (
                      <OptimisticCartVariantOptions
                        selectedOptions={selectedOptions}
                      />
                    ) : (
                      <p
                        className="mr-auto text-[0.65rem] text-primary/65"
                        role="status"
                      >
                        Updating options…
                      </p>
                    )}

                    <div
                      className={cn(
                        "ml-auto flex h-8 shrink-0 items-center border border-primary transition-opacity",
                        linePending && "opacity-45",
                      )}
                      role="group"
                      aria-label={`Quantity for ${title}: ${String(line.quantity)}`}
                      aria-describedby={lineErrors ? errorId : undefined}
                    >
                      <button
                        className="grid size-[26px] place-items-center border-r border-primary disabled:cursor-not-allowed disabled:opacity-35"
                        type="submit"
                        disabled={line.quantity <= 1}
                        aria-label={`Decrease quantity of ${title}`}
                        {...register("decrease")}
                      >
                        <MinusIcon className="size-3" aria-hidden="true" />
                      </button>
                      <span
                        className="min-w-4 text-center text-xs tabular-nums"
                        aria-hidden="true"
                      >
                        {line.quantity}
                      </span>
                      <input
                        {...register("quantity", {
                          value: line.quantity,
                          interactive: true,
                        })}
                        type="number"
                        min={1}
                        step={1}
                        aria-hidden="true"
                        tabIndex={-1}
                        className="sr-only"
                      />
                      <button
                        className="grid size-[26px] place-items-center border-l border-primary"
                        type="submit"
                        aria-label={`Increase quantity of ${title}`}
                        {...register("increase")}
                      >
                        <PlusIcon className="size-3" aria-hidden="true" />
                      </button>
                    </div>
                  </div>

                  <div
                    className="mt-auto flex items-end justify-between gap-3 pt-3"
                    data-cart-line-summary
                  >
                    <div className="flex items-center gap-1.5">
                      <p
                        className={cn(
                          "pb-0.5 text-[0.72rem] leading-none transition-opacity",
                          linePending && "opacity-45",
                        )}
                      >
                        {formatMoney(line.cost.totalAmount, {
                          locale: "en-AU",
                          currencyDisplay: "narrowSymbol",
                        }).toString()}
                      </p>
                      {lineOptimistic ? (
                        <CartLinePendingIndicator title={title} />
                      ) : null}
                    </div>

                    <CartLineRemoveButton
                      formId={formId}
                      removeButtonProps={removeButtonProps}
                      title={title}
                    />
                  </div>
                </form>

                {productId && preparingProductIds.includes(productId) ? (
                  <CartArtworkStatus productId={productId} />
                ) : null}
                {lineErrors
                  ? [...lineErrors.userErrors, ...lineErrors.warnings].map(
                      (error, index) => (
                        <p
                          id={index === 0 ? errorId : undefined}
                          role="alert"
                          className="mt-2 text-[0.65rem]"
                          key={`${String(index)}-${error.message}`}
                        >
                          {error.message}
                        </p>
                      ),
                    )
                  : null}
              </div>
            </article>
          );
        })}
      </div>

      <div
        className={cn(
          "shrink-0 bg-background",
          layout === "overlay" ? "border-t border-primary p-4" : "pt-8",
        )}
      >
        <div
          className="grid gap-1.5 text-sm transition-opacity duration-150 data-[pending=true]:opacity-45"
          data-pending={isUpdating ? "true" : "false"}
        >
          <div className="flex justify-between">
            <span>Subtotal</span>
            <strong>
              {formatMoney(cart.cost.subtotalAmount, {
                locale: "en-AU",
                currencyDisplay: "narrowSymbol",
              }).toString()}
            </strong>
          </div>
          <div className="flex justify-between" data-cart-delivery-charge>
            <span>+ shipping</span>
            <strong>
              {remainingForFreeDelivery === null
                ? "Free"
                : formatMoney(STANDARD_DELIVERY_FEE_MONEY_AUD, {
                    locale: "en-AU",
                    currencyDisplay: "narrowSymbol",
                  }).toString()}
            </strong>
          </div>
          {remainingForFreeDelivery ? (
            <p className="text-xs leading-tight" data-free-delivery-progress>
              (add{" "}
              {formatMoney(remainingForFreeDelivery, {
                locale: "en-AU",
                currencyDisplay: "narrowSymbol",
              }).toString()}{" "}
              for free shipping)
            </p>
          ) : null}
        </div>
        {cart.checkoutUrl ? (
          isUpdating ? (
            <button
              aria-busy="true"
              className="mt-4 grid min-h-12 w-full cursor-wait place-items-center border border-primary bg-primary text-xs font-bold tracking-[0.08em] text-primary-foreground uppercase opacity-65"
              disabled
              type="button"
            >
              Updating cart…
            </button>
          ) : preparingProductIds.length > 0 ? (
            <PreparingCartCheckout productIds={preparingProductIds} />
          ) : (
            <CheckoutLink />
          )
        ) : null}
      </div>

      {[
        ...errors.cart.userErrors,
        ...errors.cart.warnings,
        ...errors.network,
      ].map((error, index) => (
        <p
          role="alert"
          className="px-4 pb-2 text-xs"
          key={`${String(index)}-${error.message}`}
        >
          {error.message}
        </p>
      ))}
    </div>
  );
}

function OptimisticCartVariantOptions({
  selectedOptions,
}: {
  selectedOptions: CartSelectedOption[];
}) {
  return (
    <div className="flex min-w-0 flex-nowrap items-end gap-1.5 text-primary/65">
      {selectedOptions.map((option) => (
        <span
          aria-label={`${option.name}: ${option.value}`}
          className="flex h-8 min-w-0 max-w-24 items-center justify-between gap-1 border-b border-primary/65 py-1 text-[0.8rem] uppercase"
          key={option.name}
        >
          <span className="truncate">{option.value}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3.5 shrink-0" />
        </span>
      ))}
    </div>
  );
}

function CartLinePendingIndicator({ title }: { title: string }) {
  return (
    <span
      aria-label={`Adding ${title}`}
      className="grid size-3 shrink-0 place-items-center text-primary/65"
      role="status"
    >
      <LoaderCircleIcon
        aria-hidden="true"
        className="size-3 motion-safe:animate-spin"
      />
      <span className="sr-only">Adding item…</span>
    </span>
  );
}

function CartLineRemoveButton({
  formId,
  removeButtonProps,
  title,
}: {
  formId: string;
  removeButtonProps: ComponentProps<"button">;
  title: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <button
        className="flex min-h-8 items-end gap-1.5 pb-0.5 text-[0.65rem] leading-none underline underline-offset-2"
        type="submit"
        {...removeButtonProps}
        onClick={(event) => {
          event.preventDefault();
          setOpen(true);
        }}
      >
        <Trash2Icon className="size-4" aria-hidden="true" />
        Remove
      </button>
      <AlertDialogContent
        className="w-[min(calc(100%-2rem),24rem)] gap-0 rounded-none border border-primary bg-background p-0 text-primary ring-0"
        size="sm"
      >
        <AlertDialogHeader className="place-items-start gap-2 p-5 text-left">
          <AlertDialogTitle className="text-lg font-bold tracking-[-0.03em] text-primary">
            Remove {title}?
          </AlertDialogTitle>
          <AlertDialogDescription className="text-[0.7rem] text-primary/70">
            This item will be removed from your cart.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="mx-0 mb-0 grid grid-cols-2 gap-0 rounded-none border-t border-primary bg-transparent p-0">
          <AlertDialogCancel
            className="h-12 rounded-none border-0 border-r border-primary bg-background text-primary hover:bg-primary/5 hover:text-primary"
            size="lg"
            variant="outline"
          >
            Keep item
          </AlertDialogCancel>
          <AlertDialogAction
            className="h-12 rounded-none border-0 bg-primary text-primary-foreground hover:bg-primary/85"
            form={formId}
            size="lg"
            variant="default"
            {...removeButtonProps}
            type="submit"
          >
            Remove item
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function CheckoutLink() {
  return (
    <a
      className="mt-4 grid min-h-12 w-full place-items-center border border-primary bg-primary text-xs font-bold tracking-[0.08em] text-primary-foreground uppercase"
      href="/checkout"
      onClick={() => {
        captureStorefrontAction("checkout_requested");
      }}
    >
      Checkout
    </a>
  );
}

function CartArtworkStatus({ productId }: { productId: string }) {
  const preparation = useProductPurchaseReadiness(productId);
  if (preparation.ready) return null;
  return (
    <p className="mt-2 text-[0.65rem]" role="status">
      {preparation.error
        ? "Your item is saved. Artwork preparation could not be confirmed."
        : "Preparing artwork… You can keep shopping."}
    </p>
  );
}

function PreparingCartCheckout({
  productIds,
}: {
  productIds: readonly string[];
}) {
  const preparation = useProductsPurchaseReadiness(productIds);
  if (preparation.ready) return <CheckoutLink />;
  return (
    <>
      <button
        aria-busy={preparation.pending}
        className="mt-4 grid min-h-12 w-full place-items-center border border-primary bg-primary text-xs font-bold tracking-[0.08em] text-primary-foreground uppercase opacity-65"
        disabled
        type="button"
      >
        Preparing artwork…
      </button>
      {preparation.error ? (
        <button
          className="mt-2 text-xs underline underline-offset-2"
          onClick={preparation.retry}
          type="button"
        >
          Check artwork again
        </button>
      ) : null}
    </>
  );
}
