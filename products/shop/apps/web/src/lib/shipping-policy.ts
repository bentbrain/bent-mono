import type { MoneyV2 } from "@shopify/hydrogen";

export const STANDARD_DELIVERY_FEE_AUD = "$10.95";
export const FREE_DELIVERY_THRESHOLD_AUD = "$100";

export const STANDARD_DELIVERY_FEE_MONEY_AUD = {
  amount: "10.95",
  currencyCode: "AUD",
} satisfies MoneyV2;

const FREE_DELIVERY_THRESHOLD_CENTS_AUD = 10_000;

export function freeDeliveryRemaining(
  subtotal: MoneyV2,
): MoneyV2 | null | undefined {
  if (subtotal.currencyCode !== "AUD") return undefined;
  const subtotalCents = moneyCents(subtotal.amount);
  if (subtotalCents === undefined) return undefined;
  const remainingCents = FREE_DELIVERY_THRESHOLD_CENTS_AUD - subtotalCents;
  if (remainingCents <= 0) return null;
  return {
    amount: centsAmount(remainingCents),
    currencyCode: "AUD",
  };
}

function moneyCents(amount: string) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount);
  const dollars = match?.[1];
  if (!dollars) return undefined;
  const fraction = (match[2] ?? "").padEnd(2, "0");
  return Number(dollars) * 100 + Number(fraction);
}

function centsAmount(cents: number) {
  const dollars = Math.floor(cents / 100);
  const fraction = String(cents % 100).padStart(2, "0");
  return `${String(dollars)}.${fraction}`;
}
