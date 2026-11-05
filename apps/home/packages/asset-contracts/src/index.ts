export type CardinalDirection = "north" | "east" | "south" | "west";

export const CARDINAL_DIRECTIONS: readonly CardinalDirection[] = [
  "north",
  "east",
  "south",
  "west",
];

export interface PixelPoint {
  readonly x: number;
  readonly y: number;
}

export interface GridFootprint {
  readonly width: number;
  readonly depth: number;
}

export interface DirectionalSprite {
  readonly source: string;
  readonly width: number;
  readonly height: number;
  readonly anchor: PixelPoint;
}

export interface DirectionalViews {
  readonly north: DirectionalSprite;
  readonly east: DirectionalSprite;
  readonly south: DirectionalSprite;
  readonly west: DirectionalSprite;
}

export interface FurnitureManifest {
  readonly schemaVersion: 1;
  readonly kind: "furniture";
  readonly id: string;
  readonly displayName: string;
  readonly footprint: GridFootprint;
  readonly heightPixels: number;
  readonly palette: "apartment-hotel-v1" | "apartment-fixtures-v2";
  readonly views: DirectionalViews;
}

export interface AnimationDirection {
  readonly source: string;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly frameCount: number;
  readonly framesPerSecond: number;
  readonly anchor: PixelPoint;
}

export interface DirectionalAnimation {
  readonly north: AnimationDirection;
  readonly east: AnimationDirection;
  readonly south: AnimationDirection;
  readonly west: AnimationDirection;
}

export interface CharacterManifest {
  readonly schemaVersion: 1;
  readonly kind: "character";
  readonly id: string;
  readonly displayName: string;
  readonly footprint: GridFootprint;
  readonly palette: "apartment-hotel-v1" | "apartment-fixtures-v2";
  readonly animations: Readonly<Record<string, DirectionalAnimation>>;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validatePoint(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object.`);
    return;
  }

  if (!hasExactKeys(value, ["x", "y"])) {
    errors.push(`${path} must contain only x and y.`);
  }
  if (!isNonNegativeInteger(value.x)) {
    errors.push(`${path}.x must be a non-negative integer.`);
  }
  if (!isNonNegativeInteger(value.y)) {
    errors.push(`${path}.y must be a non-negative integer.`);
  }
}

function validateFootprint(
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object.`);
    return;
  }

  if (!hasExactKeys(value, ["width", "depth"])) {
    errors.push(`${path} must contain only width and depth.`);
  }
  if (!isPositiveInteger(value.width)) {
    errors.push(`${path}.width must be a positive integer.`);
  }
  if (!isPositiveInteger(value.depth)) {
    errors.push(`${path}.depth must be a positive integer.`);
  }
}

function validateSprite(
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object.`);
    return;
  }

  if (!hasExactKeys(value, ["source", "width", "height", "anchor"])) {
    errors.push(`${path} contains unexpected or missing fields.`);
  }
  if (!isNonEmptyString(value.source) || !value.source.endsWith(".png")) {
    errors.push(`${path}.source must be a non-empty PNG path.`);
  }
  if (!isPositiveInteger(value.width)) {
    errors.push(`${path}.width must be a positive integer.`);
  }
  if (!isPositiveInteger(value.height)) {
    errors.push(`${path}.height must be a positive integer.`);
  }
  validatePoint(value.anchor, `${path}.anchor`, errors);
}

function validateAnimationDirection(
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object.`);
    return;
  }

  const expected = [
    "source",
    "frameWidth",
    "frameHeight",
    "frameCount",
    "framesPerSecond",
    "anchor",
  ];
  if (!hasExactKeys(value, expected)) {
    errors.push(`${path} contains unexpected or missing fields.`);
  }
  if (!isNonEmptyString(value.source) || !value.source.endsWith(".png")) {
    errors.push(`${path}.source must be a non-empty PNG path.`);
  }
  for (const numericField of [
    "frameWidth",
    "frameHeight",
    "frameCount",
    "framesPerSecond",
  ]) {
    if (!isPositiveInteger(value[numericField])) {
      errors.push(`${path}.${numericField} must be a positive integer.`);
    }
  }
  validatePoint(value.anchor, `${path}.anchor`, errors);
}

function validateFourDirections(
  value: unknown,
  path: string,
  errors: string[],
  validateView: (
    view: unknown,
    viewPath: string,
    viewErrors: string[],
  ) => void,
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object.`);
    return;
  }

  if (!hasExactKeys(value, CARDINAL_DIRECTIONS)) {
    errors.push(`${path} must contain exactly north, east, south, and west.`);
  }

  for (const direction of CARDINAL_DIRECTIONS) {
    validateView(value[direction], `${path}.${direction}`, errors);
  }
}

function validateSharedManifestFields(
  value: Record<string, unknown>,
  expectedKind: "furniture" | "character",
  errors: string[],
): void {
  if (value.schemaVersion !== 1) {
    errors.push("schemaVersion must equal 1.");
  }
  if (value.kind !== expectedKind) {
    errors.push(`kind must equal "${expectedKind}".`);
  }
  if (!isNonEmptyString(value.id) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.id)) {
    errors.push("id must be a non-empty kebab-case identifier.");
  }
  if (!isNonEmptyString(value.displayName)) {
    errors.push("displayName must be a non-empty string.");
  }
  if (value.palette !== "apartment-hotel-v1" && value.palette !== "apartment-fixtures-v2") {
    errors.push('palette must be apartment-hotel-v1 or apartment-fixtures-v2.');
  }
  validateFootprint(value.footprint, "footprint", errors);
}

export function validateFurnitureManifest(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["Manifest must be an object."] };
  }

  const expected = [
    "schemaVersion",
    "kind",
    "id",
    "displayName",
    "footprint",
    "heightPixels",
    "palette",
    "views",
  ];
  if (!hasExactKeys(value, expected)) {
    errors.push("Furniture manifest contains unexpected or missing fields.");
  }
  validateSharedManifestFields(value, "furniture", errors);
  if (!isPositiveInteger(value.heightPixels)) {
    errors.push("heightPixels must be a positive integer.");
  }
  validateFourDirections(value.views, "views", errors, validateSprite);

  return { ok: errors.length === 0, errors };
}

export function validateCharacterManifest(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["Manifest must be an object."] };
  }

  const expected = [
    "schemaVersion",
    "kind",
    "id",
    "displayName",
    "footprint",
    "palette",
    "animations",
  ];
  if (!hasExactKeys(value, expected)) {
    errors.push("Character manifest contains unexpected or missing fields.");
  }
  validateSharedManifestFields(value, "character", errors);

  if (!isRecord(value.animations) || Object.keys(value.animations).length === 0) {
    errors.push("animations must contain at least one named animation.");
  } else {
    for (const [animationName, animation] of Object.entries(value.animations)) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(animationName)) {
        errors.push(`Animation name "${animationName}" must be kebab-case.`);
      }
      validateFourDirections(
        animation,
        `animations.${animationName}`,
        errors,
        validateAnimationDirection,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}
