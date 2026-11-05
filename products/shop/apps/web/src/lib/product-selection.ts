import type { SelectedOption } from "@shopify/hydrogen";

interface SelectableProductOption {
  name: string;
  optionValues: readonly unknown[];
}

export function requiresExplicitSizeSelection(
  options: readonly SelectableProductOption[],
  selectedOptions: readonly SelectedOption[],
) {
  return options.some(
    (option) =>
      option.name.toLowerCase() === "size" &&
      option.optionValues.length > 1 &&
      !selectedOptions.some(
        (selected) => selected.name.toLowerCase() === "size",
      ),
  );
}
