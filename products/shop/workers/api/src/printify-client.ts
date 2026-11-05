import { safeErrorDetails, diagnosticRoute } from "@forever-tee/contracts/diagnostics";
import type { BaseProductSlug } from "@forever-tee/contracts";

import {
  baseProductSpecification,
  LAUNCH_BASE_PRODUCTS,
  launchProductColor,
  type BaseProductSpecification,
  type LaunchProductColor,
} from "./base-product-specifications";
import type { IntegrationEnv } from "./integration-config";
import { requirePrintifyConfig } from "./integration-config";

const THE_PRINT_BAR_PROVIDER_ID = 34;

const PRINTIFY_V1_BASE_URL = "https://api.printify.com/v1/";
const REQUEST_TIMEOUT_MS = 10_000;

export class PrintifyAuthenticationError extends Error {}
export class PrintifyContractError extends Error {}
class PrintifyDependencyError extends Error {}
export class PrintifyRateLimitError extends Error {
  readonly retryAfterSeconds: number | undefined;

  constructor(retryAfterSeconds: number | undefined) {
    super("Printify rate limited the catalogue request.");
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface Blueprint {
  brand: string;
  id: number;
  model: string;
  title: string;
}

interface PrintProvider {
  id: number;
  title: string;
}

interface PrintifyShop {
  id: number;
  salesChannel: string;
  title: string;
}

interface Placeholder {
  decorationMethod: string;
  height: number;
  position: string;
  width: number;
}

interface CatalogueVariant {
  color: string;
  id: number;
  placeholders: readonly Placeholder[];
  size: string;
  title: string;
}

interface Money {
  amount: number;
  currency: string;
}

interface StandardShipping {
  additionalItems: Money;
  firstItem: Money;
  handlingDaysFrom: number;
  handlingDaysTo: number;
}

export interface BaseProductCatalogueVariant {
  readonly available: boolean;
  readonly color: LaunchProductColor;
  readonly decorationMethod: string;
  readonly id: number;
  readonly printHeight: number;
  readonly printWidth: number;
  readonly size: string;
  readonly standardShippingToAustralia: StandardShipping;
  readonly title: string;
}

export interface BaseProductPrintGeometry {
  readonly decorationMethod: string;
  readonly printHeight: number;
  readonly printWidth: number;
  readonly sizes: readonly string[];
}

export interface BaseProductCatalogue {
  readonly baseProductId: string;
  readonly baseProductSlug: BaseProductSlug;
  readonly blueprint: Blueprint;
  readonly blueprintId: number;
  readonly printProvider: PrintProvider;
  readonly printProviderId: number;
  readonly printGeometries: readonly BaseProductPrintGeometry[];
  readonly retrievedAt: string;
  readonly shop: PrintifyShop;
  readonly sourceUrls: readonly string[];
  readonly variants: readonly BaseProductCatalogueVariant[];
}

export type StapleTeeCatalogue = BaseProductCatalogue;

export function makePrintifyClient(
  env: IntegrationEnv,
  fetcher: typeof fetch = fetch,
  now: () => Date = () => new Date(),
) {
  const config = requirePrintifyConfig(env);
  const request = makePrintifyRequest(config.apiToken, fetcher);

  async function loadCatalogue(
    specification: BaseProductSpecification,
  ): Promise<BaseProductCatalogue> {
    const shopsPath = "shops.json";
    const blueprintId = String(specification.blueprintId);
    const blueprintPath = `catalog/blueprints/${blueprintId}.json`;
    const providersPath =
      `catalog/blueprints/${blueprintId}/print_providers.json`;
    const variantsPath =
      `catalog/blueprints/${blueprintId}/print_providers/${String(THE_PRINT_BAR_PROVIDER_ID)}/variants.json`;
    const shippingUrl =
      `https://api.printify.com/v2/catalog/blueprints/${blueprintId}/print_providers/${String(THE_PRINT_BAR_PROVIDER_ID)}/shipping/standard.json`;
    const [shopsPayload, blueprintPayload, providersPayload, allPayload, availablePayload, shippingPayload] =
      await Promise.all([
        request(shopsPath),
        request(blueprintPath),
        request(providersPath),
        request(`${variantsPath}?show-out-of-stock=1`),
        request(`${variantsPath}?show-out-of-stock=0`),
        request(shippingUrl),
      ]);
    const shops = parseShops(shopsPayload);
    const blueprint = parseBlueprint(blueprintPayload);
    const providers = parseProviders(providersPayload);
    const allVariants = parseVariants(allPayload);
    const availableVariants = parseVariants(availablePayload);
    const shipping = parseAustralianStandardShipping(shippingPayload);
    validateBlueprint(blueprint, specification);
    const shop = shops.find(({ id }) => String(id) === config.shopId);
    if (!shop) {
      throw new PrintifyContractError(
        "The configured Printify shop is not available to this API token.",
      );
    }
    const printProvider = providers.find(
      ({ id }) => id === THE_PRINT_BAR_PROVIDER_ID,
    );
    if (!printProvider || normalized(printProvider.title) !== "the print bar") {
      throw new PrintifyContractError(
        "Printify provider 34 is not The Print Bar.",
      );
    }
    const variants = selectBaseProductVariants(
      allVariants,
      availableVariants,
      shipping,
      specification,
    );
    const base = new URL(PRINTIFY_V1_BASE_URL);
    return {
      baseProductId: specification.baseProductId,
      baseProductSlug: specification.slug,
      blueprint,
      blueprintId: specification.blueprintId,
      printProvider,
      printProviderId: THE_PRINT_BAR_PROVIDER_ID,
      printGeometries: baseProductPrintGeometries(
        variants,
        specification.slug,
      ),
      retrievedAt: now().toISOString(),
      shop,
      sourceUrls: [
        new URL(shopsPath, base).toString(),
        new URL(blueprintPath, base).toString(),
        new URL(providersPath, base).toString(),
        new URL(`${variantsPath}?show-out-of-stock=1`, base).toString(),
        new URL(`${variantsPath}?show-out-of-stock=0`, base).toString(),
        shippingUrl,
      ],
      variants,
    };
  }

  return {
    async loadStapleTeeCatalogue(): Promise<StapleTeeCatalogue> {
      return loadCatalogue(baseProductSpecification("staple-tee"));
    },
    async loadBaseProductCatalogue(
      slug: BaseProductSlug,
    ): Promise<BaseProductCatalogue> {
      return loadCatalogue(baseProductSpecification(slug));
    },
    async loadLaunchCatalogues(): Promise<readonly BaseProductCatalogue[]> {
      return Promise.all(LAUNCH_BASE_PRODUCTS.map(loadCatalogue));
    },
    shopId: config.shopId,
  };
}

function makePrintifyRequest(apiToken: string, fetcher: typeof fetch) {
  return async (path: string) => {
    let response: Response;
    try {
      response = await fetcher(new URL(path, PRINTIFY_V1_BASE_URL), {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiToken}`,
          "User-Agent": "bent.shop",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      console.error("bent.shop Printify request failed", {
        ...safeErrorDetails(error),
        path: diagnosticRoute(new URL(path, PRINTIFY_V1_BASE_URL).pathname),
      });
      throw new PrintifyDependencyError("Printify is unavailable.");
    }
    if (response.status === 401 || response.status === 403) {
      throw new PrintifyAuthenticationError(
        "Printify rejected the configured API token.",
      );
    }
    if (response.status === 429) {
      throw new PrintifyRateLimitError(
        retryAfterSeconds(response.headers.get("retry-after")),
      );
    }
    if (!response.ok) {
      throw new PrintifyDependencyError(
        `Printify catalogue request failed with status ${String(response.status)}.`,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new PrintifyContractError("Printify returned invalid JSON.");
    }
  };
}

function parseBlueprint(value: unknown): Blueprint {
  if (!isRecord(value)) throw invalidContract("blueprint");
  const id = positiveInteger(value["id"]);
  const brand = nonEmptyString(value["brand"]);
  const model = nonEmptyString(value["model"]);
  const title = nonEmptyString(value["title"]);
  if (!id || !brand || !model || !title) throw invalidContract("blueprint");
  return { brand, id, model, title };
}

function parseProviders(value: unknown): PrintProvider[] {
  if (!Array.isArray(value)) throw invalidContract("print providers");
  return value.map((provider) => {
    if (!isRecord(provider)) throw invalidContract("print provider");
    const id = positiveInteger(provider["id"]);
    const title = nonEmptyString(provider["title"]);
    if (!id || !title) throw invalidContract("print provider");
    return { id, title };
  });
}

function parseShops(value: unknown): PrintifyShop[] {
  if (!Array.isArray(value)) throw invalidContract("shops");
  return value.map((shop) => {
    if (!isRecord(shop)) throw invalidContract("shop");
    const id = positiveInteger(shop["id"]);
    const salesChannel = nonEmptyString(shop["sales_channel"]);
    const title = nonEmptyString(shop["title"]);
    if (!id || !salesChannel || !title) throw invalidContract("shop");
    return { id, salesChannel, title };
  });
}

function parseVariants(value: unknown): CatalogueVariant[] {
  if (!isRecord(value) || !Array.isArray(value["variants"])) {
    throw invalidContract("variants");
  }
  return value["variants"].map((variant) => {
    if (!isRecord(variant) || !isRecord(variant["options"])) {
      throw invalidContract("variant");
    }
    const id = positiveInteger(variant["id"]);
    const title = nonEmptyString(variant["title"]);
    const color = nonEmptyString(variant["options"]["color"]);
    const size = nonEmptyString(variant["options"]["size"]);
    const placeholders = parsePlaceholders(variant["placeholders"]);
    if (!id || !title || !color || !size) throw invalidContract("variant");
    return { color, id, placeholders, size, title };
  });
}

function parseAustralianStandardShipping(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value["data"])) {
    throw invalidContract("standard shipping");
  }
  const shipping = new Map<number, StandardShipping>();
  for (const entry of value["data"]) {
    if (!isRecord(entry) || !isRecord(entry["attributes"])) {
      throw invalidContract("standard shipping entry");
    }
    const attributes = entry["attributes"];
    if (!isRecord(attributes["country"]) ||
        attributes["country"]["code"] !== "AU") continue;
    if (!isRecord(attributes["handlingTime"]) ||
        !isRecord(attributes["shippingCost"]) ||
        !isRecord(attributes["shippingCost"]["firstItem"]) ||
        !isRecord(attributes["shippingCost"]["additionalItems"])) {
      throw invalidContract("Australian standard shipping entry");
    }
    const variantId = positiveInteger(attributes["variantId"]);
    const handlingDaysFrom = nonNegativeInteger(
      attributes["handlingTime"]["from"],
    );
    const handlingDaysTo = nonNegativeInteger(
      attributes["handlingTime"]["to"],
    );
    const firstItem = parseMoney(attributes["shippingCost"]["firstItem"]);
    const additionalItems = parseMoney(
      attributes["shippingCost"]["additionalItems"],
    );
    if (!variantId || handlingDaysFrom === undefined ||
        handlingDaysTo === undefined || handlingDaysTo < handlingDaysFrom ||
        firstItem.currency !== additionalItems.currency) {
      throw invalidContract("Australian standard shipping entry");
    }
    const rate = {
      additionalItems,
      firstItem,
      handlingDaysFrom,
      handlingDaysTo,
    };
    const existing = shipping.get(variantId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(rate)) {
      throw new PrintifyContractError(
        `Printify returned conflicting Australian shipping rates for variant ${String(variantId)}.`,
      );
    }
    shipping.set(variantId, rate);
  }
  return shipping;
}

function parseMoney(value: Record<string, unknown>): Money {
  const amount = nonNegativeInteger(value["amount"]);
  const currency = nonEmptyString(value["currency"]);
  if (amount === undefined || !currency || !/^[A-Z]{3}$/.test(currency)) {
    throw invalidContract("money");
  }
  return { amount, currency };
}

function parsePlaceholders(value: unknown): Placeholder[] {
  if (!Array.isArray(value)) throw invalidContract("variant placeholders");
  return value.map((placeholder) => {
    if (!isRecord(placeholder)) throw invalidContract("variant placeholder");
    const decorationMethod = nonEmptyString(placeholder["decoration_method"]);
    const height = positiveInteger(placeholder["height"]);
    const position = nonEmptyString(placeholder["position"]);
    const width = positiveInteger(placeholder["width"]);
    if (!decorationMethod || !height || !position || !width) {
      throw invalidContract("variant placeholder");
    }
    return { decorationMethod, height, position, width };
  });
}

function validateBlueprint(
  blueprint: Blueprint,
  specification: BaseProductSpecification,
) {
  if (
    blueprint.id !== specification.blueprintId ||
    normalized(blueprint.brand) !== normalized(specification.brand) ||
    normalized(blueprint.model) !== normalized(specification.model)
  ) {
    throw new PrintifyContractError(
      `Printify blueprint ${String(specification.blueprintId)} does not match ${specification.brand} ${specification.model}.`,
    );
  }
}

function selectBaseProductVariants(
  allVariants: readonly CatalogueVariant[],
  availableVariants: readonly CatalogueVariant[],
  shipping: ReadonlyMap<number, StandardShipping>,
  specification: BaseProductSpecification,
): BaseProductCatalogueVariant[] {
  const allIds = new Set(allVariants.map(({ id }) => id));
  const availableIds = new Set(availableVariants.map(({ id }) => id));
  if (allIds.size !== allVariants.length ||
      availableIds.size !== availableVariants.length) {
    throw new PrintifyContractError(
      "Printify returned duplicate variant IDs.",
    );
  }
  if (availableVariants.some(({ id }) => !allIds.has(id))) {
    throw new PrintifyContractError(
      "Printify returned an in-stock variant missing from the full catalogue.",
    );
  }
  const selected: BaseProductCatalogueVariant[] = [];
  const combinations = new Set<string>();
  for (const variant of allVariants) {
    const color = launchProductColor(variant.color, specification);
    if (!color) continue;
    const frontPlaceholders = variant.placeholders.filter(
      ({ decorationMethod, position }) =>
        isFrontPosition(position) && normalized(decorationMethod) === "dtg",
    );
    if (frontPlaceholders.length === 0) continue;
    if (frontPlaceholders.length !== 1) {
      throw new PrintifyContractError(
        `Printify returned ambiguous front print areas for variant ${String(variant.id)}.`,
      );
    }
    const front = frontPlaceholders[0];
    if (!front) throw invalidContract("front print area");
    const combination = `${color}\u0000${variant.size}`;
    if (combinations.has(combination)) {
      throw new PrintifyContractError(
        `Printify returned duplicate ${color} / ${variant.size} variants.`,
      );
    }
    combinations.add(combination);
    const standardShippingToAustralia = shipping.get(variant.id);
    if (!standardShippingToAustralia) {
      throw new PrintifyContractError(
        `Printify returned no Australian standard shipping rate for variant ${String(variant.id)}.`,
      );
    }
    selected.push({
      available: availableIds.has(variant.id),
      color,
      decorationMethod: front.decorationMethod,
      id: variant.id,
      printHeight: front.height,
      printWidth: front.width,
      size: variant.size,
      standardShippingToAustralia,
      title: variant.title,
    });
  }
  if (specification.colors.some(
    (requiredColor) => !selected.some(({ color }) => color === requiredColor),
  )) {
    throw new PrintifyContractError(
      `Printify did not return every required ${specification.slug} front-DTG colour.`,
    );
  }
  if (specification.singleSize &&
      new Set(selected.map(({ size }) => normalized(size))).size !== 1) {
    throw new PrintifyContractError(
      `Printify returned more than one size for ${specification.slug}.`,
    );
  }
  if (!specification.singleSize) {
    const offeredSizes = new Set(selected.map(({ size }) => normalized(size)));
    const incompleteColor = specification.colors.find((requiredColor) =>
      [...offeredSizes].some((size) => !selected.some((variant) =>
        variant.color === requiredColor && normalized(variant.size) === size
      ))
    );
    if (incompleteColor) {
      throw new PrintifyContractError(
        `Printify did not return ${incompleteColor} for every offered ${specification.slug} size.`,
      );
    }
  }
  baseProductPrintGeometries(selected, specification.slug);
  return selected.sort((left, right) =>
    left.color.localeCompare(right.color) || left.size.localeCompare(right.size)
  );
}

export function baseProductPrintGeometries(
  variants: readonly Pick<
    BaseProductCatalogueVariant,
    "decorationMethod" | "printHeight" | "printWidth" | "size"
  >[],
  baseProductSlug: BaseProductSlug,
): readonly BaseProductPrintGeometry[] {
  const geometryBySize = new Map<string, string>();
  const geometries = new Map<string, {
    decorationMethod: string;
    printHeight: number;
    printWidth: number;
    sizes: Set<string>;
  }>();
  for (const variant of variants) {
    const normalizedSize = normalized(variant.size);
    const geometryKey =
      `${normalized(variant.decorationMethod)}\u0000${String(variant.printWidth)}\u0000${String(variant.printHeight)}`;
    const expected = geometryBySize.get(normalizedSize);
    if (expected !== undefined && expected !== geometryKey) {
      throw new PrintifyContractError(
        `Printify returned conflicting front-DTG geometry for ${baseProductSlug} / ${variant.size}.`,
      );
    }
    geometryBySize.set(normalizedSize, geometryKey);
    const geometry = geometries.get(geometryKey) ?? {
      decorationMethod: variant.decorationMethod,
      printHeight: variant.printHeight,
      printWidth: variant.printWidth,
      sizes: new Set<string>(),
    };
    geometry.sizes.add(variant.size);
    geometries.set(geometryKey, geometry);
  }
  return [...geometries.values()].map((geometry) => ({
    decorationMethod: geometry.decorationMethod,
    printHeight: geometry.printHeight,
    printWidth: geometry.printWidth,
    sizes: [...geometry.sizes].sort((left, right) => left.localeCompare(right)),
  })).sort((left, right) =>
    left.printWidth - right.printWidth || left.printHeight - right.printHeight
  );
}

function isFrontPosition(value: string) {
  const position = normalized(value);
  return position === "front" || position.startsWith("front_");
}


function retryAfterSeconds(value: string | null) {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function nonEmptyString(value: unknown) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}

function normalized(value: string) {
  return value.trim().toLocaleLowerCase("en-AU");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidContract(resource: string) {
  return new PrintifyContractError(
    `Printify returned an invalid ${resource} payload.`,
  );
}
