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

// Letters that Unicode normalization leaves whole.
const folded: Record<string, string> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  ł: "l",
  đ: "d",
  ı: "i",
  þ: "th",
};

/**
 * Text as the agent bridge compares labels: by whole words, regardless of
 * case, accents, punctuation and spacing.
 */
export function matchKey(text: string) {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[ßæœøłđıþ]/g, (letter) => folded[letter] ?? letter)
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
 * The Add and Remove labels of each saved meal, by id. Each names the meal's
 * place in the list before its title, so no label matches another however a
 * title is written, and meals that share a name add what tells them apart.
 */
export function savedMealLabels(
  meals: { id: string; data: Values }[],
  day: string,
) {
  const variants = variantNames(meals);
  return new Map(
    meals.map((meal, index) => {
      const place = `saved meal ${index + 1}: ${meal.data.name}`;
      const variant = variants.get(meal.id);
      const detail = variant ? `, ${variant}` : "";
      return [
        meal.id,
        {
          add: `Add ${place} to ${day}${detail}`,
          remove: `Remove ${place}${detail}`,
        },
      ];
    }),
  );
}
