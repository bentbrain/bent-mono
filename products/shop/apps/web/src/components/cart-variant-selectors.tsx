"use client";

import { useRef, useState } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { waitForCartActions } from "@/lib/cart-actions";

interface CartAttribute {
  key: string;
  value: string | null;
}

interface ProductOption {
  name: string;
  optionValues: { name: string }[];
}

interface SelectedOption {
  name: string;
  value: string;
}

interface ProductVariant {
  availableForSale: boolean;
  id: string;
  selectedOptions: SelectedOption[];
}

interface CartVariantSelectorsProps {
  attributes: CartAttribute[];
  lineId: string;
  merchandiseId: string;
  options: ProductOption[];
  quantity: number;
  selectedOptions: SelectedOption[];
  title: string;
  variants: ProductVariant[];
  pending: boolean;
}

const apparelSizeOrder = new Map<string, number>([
  ["XXS", 0],
  ["XS", 1],
  ["S", 2],
  ["M", 3],
  ["L", 4],
  ["XL", 5],
  ["2XL", 6],
  ["3XL", 7],
]);

export function CartVariantSelectors({
  attributes,
  lineId,
  merchandiseId,
  options,
  quantity,
  selectedOptions,
  title,
  variants,
  pending,
}: CartVariantSelectorsProps) {
  const [draft, setDraft] = useState(() => selectionRecord(selectedOptions));
  const [error, setError] = useState<string>();
  const draftRef = useRef(draft);
  const requestIdRef = useRef(0);

  async function changeOption(optionName: string, optionValue: string) {
    const nextDraft = { ...draftRef.current, [optionName]: optionValue };
    const variant = variants.find(
      (candidate) =>
        candidate.availableForSale &&
        matchesSelections(candidate.selectedOptions, nextDraft),
    );
    if (!variant || variant.id === merchandiseId) return;

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    setError(undefined);
    try {
      const actions = await waitForCartActions();
      const result = await actions.updateCart(
        {
          lines: [{
            attributes: attributes.flatMap(({ key, value }) =>
              value === null ? [] : [{ key, value }],
            ),
            id: lineId,
            merchandiseId: variant.id,
            quantity,
          }],
        },
        { event: { context: "cart" } },
      );
      const message = result.userErrors?.[0]?.message;
      if (message) throw new Error(message);
    } catch (cause) {
      if (requestId === requestIdRef.current) {
        const confirmedSelection = selectionRecord(selectedOptions);
        draftRef.current = confirmedSelection;
        setDraft(confirmedSelection);
        setError(
          cause instanceof Error
            ? cause.message
            : "That option could not be updated. Try again.",
        );
      }
    }
  }

  return (
    <div
      aria-busy={pending ? "true" : undefined}
      className={`flex min-w-0 flex-nowrap items-end gap-1.5 transition-opacity ${pending ? "opacity-45" : ""}`}
    >
      {options.map((option) => (
        <div className="min-w-0 text-[0.65rem]" key={option.name}>
          <Select
            value={draft[option.name] ?? ""}
            onValueChange={(value) => void changeOption(option.name, value)}
          >
            <SelectTrigger
              aria-label={`${option.name} for ${title}`}
              className="h-8 min-w-0 max-w-24 gap-1 rounded-none border-0 border-b border-primary bg-transparent px-0 py-1 text-[0.8rem] text-primary shadow-none hover:bg-transparent focus-visible:border-primary focus-visible:ring-0 dark:bg-transparent dark:hover:bg-transparent [&_svg]:size-3.5 [&_svg]:text-primary"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start">
              {orderedOptionValues(option).map((value) => (
                <SelectItem
                  key={value.name}
                  value={value.name}
                  disabled={!hasAvailableVariant(
                    variants,
                    draft,
                    option.name,
                    value.name,
                  )}
                >
                  {value.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ))}
      {error ? (
        <p className="basis-full text-[0.65rem]" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function orderedOptionValues(option: ProductOption) {
  if (option.name.toLowerCase() !== "size") return option.optionValues;

  return option.optionValues
    .map((value, index) => ({ index, value }))
    .sort((left, right) => {
      const leftRank = apparelSizeOrder.get(left.value.name.toUpperCase());
      const rightRank = apparelSizeOrder.get(right.value.name.toUpperCase());
      return (leftRank ?? 1000 + left.index) - (rightRank ?? 1000 + right.index);
    })
    .map(({ value }) => value);
}

function selectionRecord(selectedOptions: SelectedOption[]) {
  const result: Record<string, string> = {};
  for (const option of selectedOptions) result[option.name] = option.value;
  return result;
}

function matchesSelections(
  selectedOptions: SelectedOption[],
  selections: Record<string, string>,
) {
  return selectedOptions.every(
    (option) => selections[option.name] === option.value,
  );
}

function hasAvailableVariant(
  variants: ProductVariant[],
  current: Record<string, string>,
  optionName: string,
  optionValue: string,
) {
  const selections = { ...current, [optionName]: optionValue };
  return variants.some(
    (variant) =>
      variant.availableForSale &&
      matchesSelections(variant.selectedOptions, selections),
  );
}
