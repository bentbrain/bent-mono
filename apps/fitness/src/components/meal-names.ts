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
 * What tells saved meals that share a name apart, by id: the exact stored
 * values of the fields where they differ, whether or not those nutrients are
 * tracked. Meals with a name of their own get none.
 */
export function variantNames(meals: { id: string; data: Values }[]) {
  const groups = new Map<string, typeof meals>();
  for (const meal of meals) {
    const key = meal.data.name.toLowerCase();
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
