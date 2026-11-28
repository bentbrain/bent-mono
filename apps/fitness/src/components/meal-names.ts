import { nutrientInfo, nutrients } from "@bent/fitness-contracts/domain";
import type { Nutrient } from "@bent/fitness-contracts/domain";

type Values = { name: string; calories: number; protein: number } & Partial<
  Record<Nutrient, number>
>;
const fields = ["calories", "protein", ...nutrients] as const;

function field(value: number | undefined, key: (typeof fields)[number]) {
  const label =
    key === "calories"
      ? "kcal"
      : key === "protein"
        ? "protein"
        : nutrientInfo[key].label.toLowerCase();
  if (value === undefined) return `no ${label}`;
  return key === "calories" ? `${value} kcal` : `${value}g ${label}`;
}

/**
 * Text as the agent bridge compares labels: by whole words, regardless of
 * case, accents, punctuation and spacing.
 */
export function matchKey(text: string) {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll("ß", "ss")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * What tells saved meals that share a name apart, by id: the exact stored
 * values of the fields where they differ, whether or not those nutrients are
 * tracked. Meals with a name of their own get none.
 */
export function variantNames(meals: { id: string; data: Values }[]) {
  const groups = new Map<string, typeof meals>();
  for (const meal of meals) {
    const key = matchKey(meal.data.name);
    groups.set(key, [...(groups.get(key) ?? []), meal]);
  }
  const names = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const differing = fields.filter(
      (key) => new Set(group.map((meal) => meal.data[key])).size > 1,
    );
    for (const meal of group)
      names.set(
        meal.id,
        differing.map((key) => field(meal.data[key], key)).join(" · "),
      );
  }
  return names;
}

/**
 * Labels by id, so that no two match each other the way the agent bridge
 * compares them. A label that still matches another, as a typed title can,
 * gets the item's place in the list.
 */
export function distinctLabels(
  items: { id: string; label: string }[],
  place: string,
) {
  let labels = items.map((item) => item.label);
  for (let round = 0; round < 3; round++) {
    const counts = new Map<string, number>();
    for (const label of labels)
      counts.set(matchKey(label), (counts.get(matchKey(label)) ?? 0) + 1);
    if (![...counts.values()].some((count) => count > 1)) break;
    labels = labels.map((label, index) =>
      (counts.get(matchKey(label)) ?? 0) > 1
        ? `${label}, ${place} ${index + 1}`
        : label,
    );
  }
  return new Map(items.map((item, index) => [item.id, labels[index] ?? ""]));
}
