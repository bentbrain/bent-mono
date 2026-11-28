/**
 * The exercise catalogue: every movement Fitness can plan, with the
 * equipment it needs, how its load is measured and the defaults a routine
 * starts from. Routines copy an entry's prescription and keep its `id`, so
 * guides, history and suggestions follow the catalogue entry.
 */

/** Equipment an account can have available. */
export const equipmentTypes = [
  "dumbbells",
  "barbell",
  "squat-rack",
  "flat-bench",
  "adjustable-bench",
  "kettlebells",
  "cable-station",
  "lat-pulldown",
  "seated-row",
  "leg-press",
  "leg-curl",
  "leg-extension",
  "chest-press-machine",
  "shoulder-press-machine",
  "smith-machine",
  "pull-up-bar",
  "dip-station",
  "resistance-bands",
  "suspension-trainer",
] as const;
export type EquipmentType = (typeof equipmentTypes)[number];

export const equipmentNames: Record<EquipmentType, string> = {
  dumbbells: "Dumbbells",
  barbell: "Barbell and plates",
  "squat-rack": "Squat rack",
  "flat-bench": "Flat bench",
  "adjustable-bench": "Adjustable bench",
  kettlebells: "Kettlebells",
  "cable-station": "Cable station",
  "lat-pulldown": "Lat pulldown",
  "seated-row": "Seated cable row",
  "leg-press": "Leg press",
  "leg-curl": "Leg curl machine",
  "leg-extension": "Leg extension machine",
  "chest-press-machine": "Chest press machine",
  "shoulder-press-machine": "Shoulder press machine",
  "smith-machine": "Smith machine",
  "pull-up-bar": "Pull-up bar",
  "dip-station": "Dip station",
  "resistance-bands": "Resistance bands",
  "suspension-trainer": "Suspension trainer",
};

/** Equipment that also serves as another: an adjustable bench lays flat. */
const alsoServes: Partial<Record<EquipmentType, EquipmentType[]>> = {
  "adjustable-bench": ["flat-bench"],
};

/**
 * How an exercise's load is recorded. Weights are in kg.
 *
 * - `dumbbell`: one dumbbell; the other hand uses the same weight.
 * - `kettlebell`: one kettlebell.
 * - `barbell`: the whole bar, plates included.
 * - `machine` and `cable`: the weight the stack or pin shows.
 * - `bodyweight`: added weight, such as a belt or vest; 0 for none.
 * - `band`: no weight; progress by reps, time or a stronger band.
 */
export const loadTypes = [
  "dumbbell",
  "kettlebell",
  "barbell",
  "machine",
  "cable",
  "bodyweight",
  "band",
] as const;
export type LoadType = (typeof loadTypes)[number];

export const movementPatterns = [
  "squat",
  "hinge",
  "lunge",
  "horizontal-push",
  "vertical-push",
  "horizontal-pull",
  "vertical-pull",
  "core",
  "carry",
  "isolation",
] as const;
export type MovementPattern = (typeof movementPatterns)[number];

export const muscles = [
  "quads",
  "hamstrings",
  "glutes",
  "calves",
  "chest",
  "back",
  "shoulders",
  "biceps",
  "triceps",
  "forearms",
  "core",
] as const;
export type Muscle = (typeof muscles)[number];

export const levels = ["beginner", "intermediate", "advanced"] as const;
export type Level = (typeof levels)[number];

export type CatalogueExercise = {
  id: string;
  name: string;
  /** Every item the exercise needs. An empty list needs only the floor. */
  equipment: EquipmentType[];
  load: LoadType;
  pattern: MovementPattern;
  muscles: Muscle[];
  level: Level;
  mode: "reps" | "seconds";
  /** Recorded for each side, left and right. */
  side: boolean;
  /** Starting prescription: sets, the rep or second range and rest in seconds. */
  sets: number;
  min: number;
  max: number;
  rest: number;
};

type Entry = Omit<CatalogueExercise, "side" | "rest" | "mode"> &
  Partial<Pick<CatalogueExercise, "side" | "rest" | "mode">>;
const entry = (value: Entry): CatalogueExercise => ({
  side: false,
  rest: 120,
  mode: "reps",
  ...value,
});

export const catalogue: CatalogueExercise[] = [
  entry({
    id: "squat",
    name: "Goblet squat",
    equipment: ["dumbbells"],
    load: "dumbbell",
    pattern: "squat",
    muscles: ["quads", "glutes", "core"],
    level: "beginner",
    sets: 3,
    min: 8,
    max: 12,
  }),
  entry({
    id: "bench",
    name: "Flat dumbbell bench press",
    equipment: ["dumbbells", "flat-bench"],
    load: "dumbbell",
    pattern: "horizontal-push",
    muscles: ["chest", "triceps", "shoulders"],
    level: "beginner",
    sets: 3,
    min: 8,
    max: 12,
  }),
  entry({
    id: "row",
    name: "Supported one-arm row",
    equipment: ["dumbbells", "flat-bench"],
    load: "dumbbell",
    pattern: "horizontal-pull",
    muscles: ["back", "biceps"],
    level: "beginner",
    sets: 3,
    min: 10,
    max: 15,
    side: true,
  }),
  entry({
    id: "rdl",
    name: "Dumbbell Romanian deadlift",
    equipment: ["dumbbells"],
    load: "dumbbell",
    pattern: "hinge",
    muscles: ["hamstrings", "glutes", "back"],
    level: "beginner",
    sets: 3,
    min: 8,
    max: 12,
  }),
  entry({
    id: "raise",
    name: "Lateral raise",
    equipment: ["dumbbells"],
    load: "dumbbell",
    pattern: "isolation",
    muscles: ["shoulders"],
    level: "beginner",
    sets: 2,
    min: 12,
    max: 20,
    rest: 75,
  }),
  entry({
    id: "plank",
    name: "Forearm plank",
    equipment: [],
    load: "bodyweight",
    pattern: "core",
    muscles: ["core"],
    level: "beginner",
    sets: 2,
    min: 20,
    max: 40,
    rest: 75,
    mode: "seconds",
  }),
  entry({
    id: "split",
    name: "Stationary split squat",
    equipment: ["dumbbells"],
    load: "dumbbell",
    pattern: "lunge",
    muscles: ["quads", "glutes"],
    level: "beginner",
    sets: 3,
    min: 8,
    max: 12,
    side: true,
  }),
  entry({
    id: "incline",
    name: "Low-incline dumbbell press",
    equipment: ["dumbbells", "adjustable-bench"],
    load: "dumbbell",
    pattern: "horizontal-push",
    muscles: ["chest", "shoulders", "triceps"],
    level: "beginner",
    sets: 3,
    min: 8,
    max: 12,
  }),
  entry({
    id: "press",
    name: "Seated dumbbell shoulder press",
    equipment: ["dumbbells", "adjustable-bench"],
    load: "dumbbell",
    pattern: "vertical-push",
    muscles: ["shoulders", "triceps"],
    level: "beginner",
    sets: 2,
    min: 8,
    max: 12,
  }),
  entry({
    id: "curl",
    name: "Hammer curl",
    equipment: ["dumbbells"],
    load: "dumbbell",
    pattern: "isolation",
    muscles: ["biceps", "forearms"],
    level: "beginner",
    sets: 2,
    min: 10,
    max: 15,
    rest: 75,
  }),
];

const byId = new Map(catalogue.map((item) => [item.id, item]));
export function catalogueEntry(id: string): CatalogueExercise | undefined {
  return byId.get(id);
}

/** The equipment types `available` provides, including what each item also serves as. */
export function providedEquipment(available: readonly EquipmentType[]) {
  const provided = new Set<EquipmentType>(available);
  for (const item of available)
    for (const other of alsoServes[item] ?? []) provided.add(other);
  return provided;
}

/** The items an exercise needs that `available` lacks. */
export function missingEquipment(
  exercise: Pick<CatalogueExercise, "equipment">,
  available: readonly EquipmentType[],
): EquipmentType[] {
  const provided = providedEquipment(available);
  return exercise.equipment.filter((item) => !provided.has(item));
}
