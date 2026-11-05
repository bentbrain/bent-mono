"use client";

import { captureStorefrontAction } from "@/client/posthog";

import {
  canAddToCart,
  formatMoney,
  type SelectedOption,
} from "@shopify/hydrogen";
import type {
  BaseProductSlug,
  ProductDefaultColor,
} from "@forever-tee/contracts";
import { createProductComponents } from "@shopify/hydrogen/react";
import { ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useQueryStates } from "nuqs";
import { useEffect, useEffectEvent, useState, type ReactNode, type SyntheticEvent } from "react";

import { BaseProductMockup } from "@/components/base-product-mockup";
import { ComposedGarmentMockup } from "@/components/composed-garment-mockup";
import {
  BaseProductDescription,
  GarmentSizeGuide,
} from "@/components/garment-details";
import { ProductMediaGallery } from "@/components/product-media-gallery";
import { ProductOptionLink } from "@/components/product-option-link";
import { ProductFulfilmentEstimate } from "@/components/product-fulfilment-estimate";
import { useProductControlsReady, useProductPanelActive } from "@/components/product-family";
import { ProductShare } from "@/components/product-share";
import { DeleteDesign } from "@/components/delete-design";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ProductData } from "@/lib/product-query";
import type { FulfilmentEstimate } from "@/lib/fulfilment-estimate";
import { waitForCartActions } from "@/lib/cart-actions";
import { useCart } from "@/lib/cart";
import { openCartDrawer } from "@/lib/cart-drawer";
import { cartProductImagePath } from "@/lib/product-image";
import {
  canonicalProductParsers,
  canonicalProductSelectionParams,
  landingProductParsers,
  landingProductSelectionParams,
  productDefaultColorValue,
  productOptionQueryParamName,
  productVariantUrl,
  type LandingProductOptionPrefix,
} from "@/lib/product-params";
import { createPath } from "@/lib/products";
import { storefrontProductTitle } from "@/lib/storefront-brand";
import { cn } from "@/lib/utils";

const { ProductProvider, useProductForm } =
  createProductComponents<ProductData>();

interface ProductConfiguratorProps {
  baseProductSlug?: BaseProductSlug;
  designId?: string;
  defaultColor?: ProductDefaultColor;
  fulfilmentEstimate?: FulfilmentEstimate;
  fulfilmentEstimateContent?: ReactNode;
  unavailableProductLabel?: string | undefined;
  imageRevision?: string;
  onVariantUrlChange?: (url: string) => void;
  optionQueryParamPrefix?: LandingProductOptionPrefix;
  onRetryPurchase?: () => void;
  product: ProductData;
  productId?: string;
  productPathname?: string;
  purchaseError?: boolean;
  purchasePending?: boolean;
  purchaseReady?: boolean;
  showMockup?: boolean;
  syncUrl?: boolean;
}

export function ProductConfigurator(props: ProductConfiguratorProps) {
  if (props.optionQueryParamPrefix) {
    return (
      <LandingProductConfigurator
        {...props}
        optionQueryParamPrefix={props.optionQueryParamPrefix}
      />
    );
  }
  return <CanonicalProductConfigurator {...props} />;
}

function LandingProductConfigurator(props: ProductConfiguratorProps & {
  optionQueryParamPrefix: LandingProductOptionPrefix;
}) {
  const panelActive = useProductPanelActive();
  const [landingProductParams, setLandingProductParams] = useQueryStates(landingProductParsers, {
    clearOnDefault: false,
    history: "replace",
    scroll: false,
  });

  return (
    <ProductProvider
      key={productInventoryKey(props.product)}
      product={props.product}
      onSelect={(result) => {
        if (props.syncUrl === false || !panelActive) return;
        const params = landingProductSelectionParams(
          props.optionQueryParamPrefix,
          result.selectedOptions,
        );
        const shallow = result.status === "resolved" ||
          !hasCompleteOptionSelection(props.product, result.selectedOptions);
        const defaults = landingProductSelectionParams(
          props.optionQueryParamPrefix,
          [{ name: "Color", value: initialProductColor(props) }],
        );
        if (shallow && selectionQueryMatches(landingProductParams, params, defaults)) return;
        deferProductQueryUpdate(() => {
          void setLandingProductParams(params, { shallow });
        });
      }}
    >
      <ProductDetails {...props} />
    </ProductProvider>
  );
}

function CanonicalProductConfigurator(props: ProductConfiguratorProps) {
  const panelActive = useProductPanelActive();
  const [productParams, setProductParams] = useQueryStates(canonicalProductParsers, {
    clearOnDefault: false,
    history: "replace",
    scroll: false,
  });

  return (
    <ProductProvider
      key={productInventoryKey(props.product)}
      product={props.product}
      onSelect={(result) => {
        if (props.syncUrl === false || !panelActive) return;
        const params = canonicalProductSelectionParams(result.selectedOptions);
        const shallow = result.status === "resolved" ||
          !hasCompleteOptionSelection(props.product, result.selectedOptions);
        if (shallow && selectionQueryMatches(productParams, params, {
          Color: initialProductColor(props), Size: null,
        })) return;
        deferProductQueryUpdate(() => {
          void setProductParams(params, { shallow });
        });
      }}
    >
      <ProductDetails {...props} />
    </ProductProvider>
  );
}

export function productInventoryKey(product: ProductData) {
  const variants = [
    product.selectedOrFirstAvailableVariant,
    ...product.adjacentVariants,
    ...product.options.flatMap((option) =>
      option.optionValues.map((value) => value.firstSelectableVariant),
    ),
  ];
  const inventory = variants
    .filter((variant) => variant !== null)
    .map((variant) => `${variant.id}:${variant.availableForSale ? "1" : "0"}`)
    .sort()
    .join(",");

  return [
    product.id,
    product.encodedVariantExistence ?? "",
    product.encodedVariantAvailability ?? "",
    inventory,
  ].join(":");
}

function ProductDetails({
  baseProductSlug = "staple-tee",
  product,
  productId,
  productPathname,
  designId,
  defaultColor = "White",
  fulfilmentEstimate,
  fulfilmentEstimateContent,
  unavailableProductLabel,
  imageRevision,
  onVariantUrlChange,
  optionQueryParamPrefix,
  onRetryPurchase,
  purchaseError = false,
  purchasePending = false,
  purchaseReady = true,
  showMockup = true,
}: ProductConfiguratorProps) {
  const panelActive = useProductPanelActive();
  const controlsReady = useProductControlsReady();
  const currentPathname = usePathname();
  const pathname = productPathname ?? currentPathname;
  const searchParams = useSearchParams();
  const [cartError, setCartError] = useState<string>();
  const [sizeGuideOpen, setSizeGuideOpen] = useState(false);
  const cartLines = useCart((state) => state.data.lines.nodes);
  const productTitle = storefrontProductTitle(product.title);
  const defaultVariantColor = productDefaultColorValue(defaultColor, baseProductSlug);
  const { options, register, selectedVariant, selectOption } = useProductForm();
  const addable = canAddToCart(product, options);
  const selectedColor = options.find(
    (option) => option.name.toLowerCase() === "color",
  )?.values.find((value) => value.selected)?.name ??
    selectedVariant?.selectedOptions.find(
      (option) => option.name.toLowerCase() === "color",
    )?.value ?? defaultVariantColor;
  const price = selectedVariant?.price ?? product.priceRange.minVariantPrice;
  const visibleOptions = options.filter((option) => option.values.length > 1);
  const showsSizeGuide = baseProductSlug === "staple-tee" &&
    visibleOptions.some((option) => option.name.toLowerCase() === "size");
  const missingOptions = visibleOptions.filter(
    (option) => !option.values.some((value) => value.selected),
  );
  const disabledAddLabel = optionSelectionPrompt(missingOptions.map(
    (option) => productOptionLabel(option.name),
  ));
  const selectedOptions = options.flatMap((option) =>
    option.values
      .filter((value) => value.selected)
      .map((value) => ({ name: option.name, value: value.name })),
  );
  const selectedOptionsUrl = productVariantUrl(
    pathname,
    product.options,
    selectedOptions,
    searchParams,
    optionQueryParamPrefix,
  );

  const reportVariantUrl = useEffectEvent((url: string) => {
    onVariantUrlChange?.(url);
  });

  useEffect(() => {
    // Family panels recreate their callbacks when a sibling reports its URL.
    // Notify only for a changed selection, not for that parent render.
    reportVariantUrl(selectedOptionsUrl);
  }, [selectedOptionsUrl]);

  useEffect(() => {
    const colorOption = options.find(
      (option) => option.name.toLowerCase() === "color",
    );
    if (!colorOption || colorOption.values.some((value) => value.selected)) {
      return;
    }
    const requestedColor = searchParams.get(
      productOptionQueryParamName(colorOption.name, optionQueryParamPrefix),
    ) ?? searchParams.get(colorOption.name);
    const selectedDefaultColor = colorOption.values.find(
      (value) => value.exists && value.name === requestedColor,
    ) ?? colorOption.values.find(
      (value) => value.exists && value.name === defaultVariantColor,
    ) ?? colorOption.values.find(
      (value) => value.exists && value.name.toLowerCase() === "black",
    ) ?? colorOption.values.find((value) => value.exists);
    if (selectedDefaultColor) {
      selectOption(colorOption.name, selectedDefaultColor.name);
    }
  }, [defaultVariantColor, optionQueryParamPrefix, options, searchParams, selectOption]);

  async function submitCart(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !designId ||
      !productId ||
      !purchaseReady ||
      !selectedVariant ||
      !addable
    ) {
      return;
    }
    const [existingLine, ...duplicateLines] = cartLines.filter((line) =>
      line.merchandise.id === selectedVariant.id &&
      line.attributes.some(
        ({ key, value }) => key === "_productId" && value === productId,
      )
    );
    setCartError(undefined);
    openCartDrawer();
    try {
      const actions = await waitForCartActions();
      const mutation = actions.updateCart(
        {
          lines: existingLine
            ? [{
                id: existingLine.id,
                quantity: [existingLine, ...duplicateLines].reduce(
                  (quantity, line) => quantity + line.quantity,
                  1,
                ),
              }, ...duplicateLines.map((line) => ({
                id: line.id,
                quantity: 0,
              }))]
            : [{
              attributes: [{ key: "_productId", value: productId }],
              merchandiseId: selectedVariant.id,
              quantity: 1,
            }],
        },
        {
          event: {
            context: "product",
            detail: {
              products: [
                {
                  id: selectedVariant.id,
                  image: {
                    altText: `${selectedColor} ${productTitle} with your artwork`,
                    url: cartProductImagePath({
                      color: selectedColor,
                      productId,
                    }),
                  },
                  price: selectedVariant.price,
                  product: {
                    handle: product.handle,
                    title: productTitle,
                  },
                  selectedOptions: selectedVariant.selectedOptions,
                  title: selectedVariant.title,
                },
              ],
            },
          },
        },
      );
      const result = await mutation;
      const userError = result.userErrors
        ?.map(({ message }) => message.trim())
        .filter((message) => message.length > 0)
        .join(" ");
      if (userError) {
        setCartError(userError);
      }
    } catch (error) {
      setCartError(
        error instanceof Error
          ? error.message
          : "The item could not be added. Try again.",
      );
    }
  }

  const formattedPrice = formatMoney(price, {
    locale: "en-AU",
    currencyDisplay: "narrowSymbol",
  }).withoutTrailingZeros;
  const productOptions = visibleOptions.length > 0 ? (
    <section id="product-options" className="border-b border-primary px-3 py-4">
      <h2 className="sr-only">Product options</h2>
      {showsSizeGuide ? (
        <div className="mb-2 flex min-h-11 items-center justify-end">
          <button
            type="button"
            className="min-h-11 text-[0.58rem] font-bold uppercase underline underline-offset-4"
            onClick={() => {
              setSizeGuideOpen(true);
            }}
          >
            Size guide
          </button>
        </div>
      ) : null}
      <div className="flex items-end gap-3" data-product-variant-row>
        {visibleOptions.map((option) => {
          const colorOption = option.name.toLowerCase() === "color";
          const sizeOption = option.name.toLowerCase() === "size";
          const selectedValue = option.values.find((value) => value.selected);
          const displayedValues = sizeOption
            ? orderedSizeValues(option.values)
            : colorOption
              ? option.values.toSorted((left, right) =>
                  Number(right.name === defaultVariantColor) - Number(left.name === defaultVariantColor)
                )
              : option.values;
          return (
            <fieldset
              className={cn(
                "min-w-0 border-0",
                colorOption ? "shrink-0" : "flex-1",
              )}
              key={option.name}
            >
              <legend className="sr-only">{option.name}</legend>
              {sizeOption ? (
                <>
                  <Select
                    disabled={!controlsReady}
                    {...(selectedValue ? { value: selectedValue.name } : {})}
                    onValueChange={(value) => {
                      selectOption(option.name, value);
                    }}
                  >
                    <SelectTrigger
                      aria-label="Size"
                      className="w-full rounded-none border-primary bg-background px-3 font-mono text-[0.65rem] font-bold text-primary uppercase shadow-none focus-visible:border-primary focus-visible:ring-primary/25"
                      size="lg"
                    >
                      <SelectValue placeholder="Choose size">{selectedValue?.name}</SelectValue>
                    </SelectTrigger>
                    <SelectContent
                      align="start"
                      position="popper"
                      sideOffset={4}
                      className="min-w-[var(--radix-select-trigger-width)] rounded-none border border-primary bg-background font-mono text-primary shadow-none ring-0"
                    >
                      {displayedValues.map((value) => (
                        <SelectItem
                          className="min-h-11 rounded-none text-[0.65rem] font-bold focus:bg-primary focus:text-primary-foreground"
                          data-available={value.available ? "true" : "false"}
                          disabled={!value.exists}
                          key={value.name}
                          value={value.name}
                        >
                          {value.name}{!value.available && value.exists
                            ? " · Sold out"
                            : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <noscript>
                    <form action={pathname} method="get">
                      {options.flatMap((otherOption) =>
                        otherOption.name === option.name
                          ? []
                          : otherOption.values
                            .filter((value) => value.selected)
                            .map((value) => (
                              <input
                                key={otherOption.name}
                                name={productOptionQueryParamName(
                                  otherOption.name,
                                  optionQueryParamPrefix,
                                )}
                                type="hidden"
                                value={value.name}
                              />
                            )),
                      )}
                      <select
                        className="min-h-11 w-full border border-primary bg-background px-3 text-[0.65rem] font-bold"
                        defaultValue={selectedValue?.name ?? ""}
                        name={productOptionQueryParamName(
                          option.name,
                          optionQueryParamPrefix,
                        )}
                      >
                        <option disabled value="">Choose size</option>
                        {displayedValues.map((value) => (
                          <option
                            disabled={!value.exists}
                            key={value.name}
                            value={value.name}
                          >
                            {value.name}{!value.available && value.exists
                              ? " · Sold out"
                              : ""}
                          </option>
                        ))}
                      </select>
                      <button className="sr-only" type="submit">
                        Apply size
                      </button>
                    </form>
                  </noscript>
                </>
              ) : (
                <div className="flex gap-1.5">
                  {displayedValues.map((value) => {
                    if (!value.exists) {
                      return (
                        <button
                          className="min-h-11 w-full border border-primary bg-background px-2 text-center text-[0.65rem] font-bold text-primary uppercase disabled:opacity-42 disabled:line-through"
                          key={value.name}
                          type="button"
                          disabled
                        >
                          {value.name}
                        </button>
                      );
                    }
                    const {
                      onClick: selectOptionValue,
                      ...optionRegistration
                    } = register("optionValue", {
                      optionName: option.name,
                      value: value.name,
                    });
                    return (
                      <ProductOptionLink
                        key={value.name}
                        prefetch={false}
                        href={productVariantUrl(
                          pathname,
                          product.options,
                          value.selectedOptions,
                          searchParams,
                          optionQueryParamPrefix,
                        )}
                        replace
                        scroll={false}
                        onSelect={() => {
                          selectOptionValue();
                        }}
                        onNavigate={(event) => {
                          event.preventDefault();
                        }}
                        aria-label={
                          colorOption
                            ? `${option.name}: ${value.name}`
                            : undefined
                        }
                        aria-current={value.selected ? "true" : undefined}
                        data-available={value.available ? "true" : "false"}
                        className={cn(
                          "grid size-11 min-h-11 place-items-center border border-primary text-center text-[0.65rem] font-bold uppercase data-[available=false]:opacity-42 data-[available=false]:line-through",
                          colorOption && value.name.toLowerCase() === "black"
                            ? "bg-black text-white"
                            : undefined,
                          colorOption && value.name.toLowerCase() !== "black"
                            ? "bg-white text-black"
                            : undefined,
                        )}
                        {...optionRegistration}
                      >
                        {colorOption ? (
                          <>
                            <span className="sr-only">{value.name}</span>
                            {value.selected ? (
                              <span aria-hidden="true">✓</span>
                            ) : null}
                          </>
                        ) : (
                          value.name
                        )}
                        {!value.available ? (
                          <span className="sr-only"> (Sold out)</span>
                        ) : null}
                      </ProductOptionLink>
                    );
                  })}
                </div>
              )}
            </fieldset>
          );
        })}
      </div>
    </section>
  ) : null;

  const commerce = (
    <div className="self-start" data-product-commerce>
      <div className="bg-background max-[900px]:border-x max-[900px]:border-primary">
        <div className="border-b border-primary" data-product-purchase>
          {productOptions}

          <div
            className="grid gap-[0.55rem] px-3 py-3"
            data-product-actions
          >
            {designId ? (
              <ProductPurchaseControls
                addable={addable}
                formattedPrice={formattedPrice}
                onRetryPurchase={onRetryPurchase}
                onSubmit={(event) => {
                  captureStorefrontAction("cart_add_requested");
                  void submitCart(event);
                }}
                purchaseError={purchaseError}
                purchasePending={purchasePending}
                purchaseReady={purchaseReady}
                unavailableLabel={disabledAddLabel}
              />
            ) : null}

            <div className="flex gap-[0.55rem]">
              <ProductShare />
              <div className="min-w-0 flex-1">
                <CreateDesignAction />
              </div>
            </div>

            {fulfilmentEstimateContent ?? <ProductFulfilmentEstimate estimate={fulfilmentEstimate} />}

            {unavailableProductLabel ? (
              <p className="text-[0.68rem]" role="status">
                {unavailableProductLabel} couldn’t be prepared for this design.
                Your design is saved, and you can continue with this product.
              </p>
            ) : null}

            {purchasePending ? (
              <p className="text-[0.68rem]" role="status">
                You can choose your colour and size while we save the print-ready
                artwork.
              </p>
            ) : null}
            {purchaseError ? (
              <p className="text-[0.68rem]" role="alert">
                Your design is safe here, but it must finish saving before it can
                be added to the cart.
              </p>
            ) : null}
          </div>
        </div>

        <details className="group border-b border-primary">
          <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-3 marker:hidden">
            <span className="text-[0.65rem] font-bold">
              Product details
            </span>
            <span
              className="grid size-6 shrink-0 place-items-center transition-transform group-open:rotate-180"
              aria-hidden="true"
            >
              <ChevronDownIcon className="size-4" strokeWidth={2} />
            </span>
          </summary>
          <div className="px-3 pb-4">
            <BaseProductDescription baseProductSlug={baseProductSlug} />
          </div>
        </details>

        {cartError ? (
          <p className="px-3 pb-3 text-[0.68rem]" role="alert">
            {cartError}
          </p>
        ) : null}

        <Dialog open={sizeGuideOpen} onOpenChange={setSizeGuideOpen}>
          <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-4xl min-w-0 overflow-hidden rounded-none border border-primary bg-background text-primary ring-0 sm:max-w-4xl">
            <DialogHeader className="min-w-0 pr-8">
              <DialogTitle className="font-mono text-base font-bold">
                Size guide
              </DialogTitle>
              <DialogDescription className="font-mono text-xs text-primary">
                Garment measurements in centimetres.
              </DialogDescription>
            </DialogHeader>
            <GarmentSizeGuide />
          </DialogContent>
        </Dialog>
      </div>
      {designId && panelActive ? (
        <div className="flex justify-center pt-2">
          <DeleteDesign designId={designId} />
        </div>
      ) : null}
    </div>
  );

  if (!showMockup) return commerce;

  return (
    <section
      className="relative z-10 bg-background text-primary"
      aria-label={`${productTitle} purchase options`}
    >
      <h1 className="sr-only">{productTitle}</h1>
      <div className="mx-auto grid max-w-[1400px] grid-cols-[minmax(0,1.25fr)_minmax(280px,0.75fr)] gap-[clamp(2rem,5vw,6rem)] max-[900px]:grid-cols-1 max-[900px]:gap-0">
        <div className="grid aspect-square w-full place-items-center overflow-hidden">
          {designId && imageRevision ? (
            <ProductMediaGallery
              revision={imageRevision}
              baseProductSlug={baseProductSlug}
              color={selectedColor}
              productId={productId}
              productTitle={productTitle}
            >
              <ComposedGarmentMockup
                baseProductSlug={baseProductSlug}
                color={selectedColor}
                designId={designId}
                {...(productId ? { productId } : {})}
                revision={imageRevision}
                preload={panelActive}
                preloadAlternateColors={panelActive}
                sizes="(max-width: 900px) 100vw, 54vw"
                ariaLabel={`${selectedColor} ${productTitle} with your artwork`}
              />
            </ProductMediaGallery>
          ) : !designId ? (
            <BaseProductMockup
              baseProductSlug={baseProductSlug}
              color={selectedColor}
            />
          ) : (
            <div
              className="aspect-square w-full border border-dotted border-primary bg-surface"
              data-skeleton-block
              role="status"
              aria-label="Loading product image"
            />
          )}
        </div>
        {commerce}
      </div>
    </section>
  );
}

const addToCartButtonClassName =
  "grid min-h-14 w-full place-items-center border border-primary bg-primary p-4 text-center text-xs font-bold tracking-[0.08em] text-primary-foreground uppercase hover:bg-background hover:text-primary disabled:cursor-not-allowed disabled:opacity-45 max-[900px]:min-h-12 max-[900px]:p-3";

interface ProductPurchaseControlsProps {
  addable: boolean;
  formattedPrice: string;
  onRetryPurchase: (() => void) | undefined;
  onSubmit: (event: SyntheticEvent<HTMLFormElement>) => void;
  purchaseError: boolean;
  purchasePending: boolean;
  purchaseReady: boolean;
  unavailableLabel?: string;
}

export function ProductPurchaseControls({
  addable,
  formattedPrice,
  onRetryPurchase,
  onSubmit,
  purchaseError,
  purchasePending,
  purchaseReady,
  unavailableLabel = "Sold out",
}: ProductPurchaseControlsProps) {
  return (
    <div>
      <form className="w-full" onSubmit={onSubmit}>
        {purchaseError ? (
          <button
            data-product-action="add-to-cart"
            className={addToCartButtonClassName}
            type="button"
            onClick={onRetryPurchase}
          >
            {formattedPrice} · Try saving again
          </button>
        ) : (
          <button
            data-product-action="add-to-cart"
            className={addToCartButtonClassName}
            type="submit"
            disabled={!addable || purchasePending || !purchaseReady}
          >
            {formattedPrice} · {purchasePending
              ? "Saving your design…"
              : addable
                ? "Add to cart"
                : unavailableLabel}
          </button>
        )}
      </form>
    </div>
  );
}

const garmentSizeOrder = new Map([
  ["XXS", 0],
  ["XS", 1],
  ["S", 2],
  ["M", 3],
  ["L", 4],
  ["XL", 5],
  ["2XL", 6],
  ["3XL", 7],
  ["4XL", 8],
  ["5XL", 9],
]);

function orderedSizeValues<T extends { name: string }>(values: readonly T[]) {
  return values.toSorted((left, right) => {
    const leftOrder = garmentSizeOrder.get(left.name.trim().toUpperCase()) ??
      Number.MAX_SAFE_INTEGER;
    const rightOrder = garmentSizeOrder.get(right.name.trim().toUpperCase()) ??
      Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder;
  });
}

function optionSelectionPrompt(optionNames: string[]) {
  const names = optionNames.map((name) => name.toLowerCase());
  const firstName = names[0];
  if (!firstName) return "Sold out";
  if (names.length === 1) return `Choose ${firstName}`;
  const lastName = names.at(-1);
  if (!lastName) return "Sold out";
  return `Choose ${names.slice(0, -1).join(", ")} and ${lastName}`;
}

function productOptionLabel(name: string) {
  return name.toLowerCase() === "color" ? "Colour" : name;
}

export function CreateDesignAction() {
  return (
    <Link
      className="grid min-h-14 w-full place-items-center border border-primary bg-background p-4 text-center text-xs font-bold tracking-[0.08em] text-primary uppercase hover:bg-primary hover:text-primary-foreground max-[900px]:min-h-12 max-[900px]:p-3"
      data-product-action="make-your-own"
      href={createPath()}
      prefetch
    >
      Make your own
    </Link>
  );
}

function hasCompleteOptionSelection(
  product: Pick<ProductData, "options">,
  selectedOptions: readonly SelectedOption[],
) {
  return product.options.every((option) =>
    selectedOptions.some((selected) => selected.name === option.name)
  );
}

function deferProductQueryUpdate(update: () => void) {
  queueMicrotask(update);
}

function selectionQueryMatches(
  current: Readonly<Record<string, string | null>>,
  selected: Readonly<Record<string, string | null>>,
  defaults: Readonly<Record<string, string | null>>,
) {
  // Restoring the initial selection must not queue a redundant history write:
  // its later flush can cancel a customer's navigation away from this page.
  // An omitted colour already resolves to the immutable product's default.
  return Object.entries(selected).every(([key, value]) =>
    (current[key] ?? defaults[key] ?? null) === value
  );
}

function initialProductColor(props: ProductConfiguratorProps) {
  return productDefaultColorValue(props.defaultColor ?? "White", props.baseProductSlug ?? "staple-tee");
}
