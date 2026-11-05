import { Either, Schema } from "effect";

import { CHECKOUT_ARTWORK_NOTE } from "@/lib/checkout-artwork-note";

const MAX_CART_LINES = 50;
export const MAX_CART_TOTAL_QUANTITY = 10;
const MAX_LINES_PER_MUTATION = 10;
export const MAX_LINE_QUANTITY = 10;

const CartIdentifier = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(256),
);
const Attribute = Schema.Struct({
  key: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100)),
  value: Schema.String.pipe(Schema.maxLength(500)),
});
const Attributes = Schema.Array(Attribute).pipe(Schema.maxItems(20));
const AddLine = Schema.Struct({
  attributes: Schema.optionalWith(Attributes, { default: () => [] }),
  merchandiseId: CartIdentifier,
  quantity: Schema.Int.pipe(Schema.between(1, MAX_LINE_QUANTITY)),
  sellingPlanId: Schema.optional(CartIdentifier),
});
const AddLines = Schema.Array(AddLine).pipe(
  Schema.minItems(1),
  Schema.maxItems(MAX_LINES_PER_MUTATION),
);
const AddRequest = Schema.Struct({
  cartId: Schema.optional(CartIdentifier),
  lines: AddLines,
});
const UpdateLine = Schema.Struct({
  attributes: Schema.optionalWith(Attributes, { default: () => [] }),
  id: CartIdentifier,
  merchandiseId: Schema.optional(CartIdentifier),
  quantity: Schema.Int.pipe(Schema.between(0, MAX_LINE_QUANTITY)),
  sellingPlanId: Schema.optional(Schema.NullOr(CartIdentifier)),
});
const UpdateLines = Schema.Array(UpdateLine).pipe(
  Schema.minItems(1),
  Schema.maxItems(MAX_LINES_PER_MUTATION),
);
const UpdateRequest = Schema.Struct({
  cartId: Schema.optional(CartIdentifier),
  lines: UpdateLines,
});

export type CartAttribute = Schema.Schema.Type<typeof Attribute>;
export type VerifiedAddRequest = Schema.Schema.Type<typeof AddRequest>;
export type VerifiedUpdateRequest = Schema.Schema.Type<typeof UpdateRequest>;

export interface CartLineSnapshot {
  readonly attributes: readonly CartAttribute[];
  readonly id: string;
  readonly merchandiseId?: string;
  readonly quantity: number;
  readonly sellingPlanId?: string;
}

export interface CartSnapshot {
  readonly id: string;
  readonly lines: readonly CartLineSnapshot[];
  readonly totalQuantity: number;
}

export interface VariantCandidate {
  readonly availableForSale: boolean;
  readonly baseProductId?: string;
  readonly productId: string;
  readonly requiresSellingPlan: boolean;
  readonly sellingPlanIds: readonly string[];
  readonly typeName: string;
}

export type CartLinesMutation =
  | { readonly kind: "add"; readonly request: VerifiedAddRequest }
  | { readonly kind: "update"; readonly request: VerifiedUpdateRequest };

export class CartIntegrityError extends Error {}

export function decodeCartLinesMutation(value: unknown): CartLinesMutation | undefined {
  if (!isRecord(value) || !Array.isArray(value["lines"])) return undefined;
  const lines = value["lines"];
  const linesWithIds = lines.filter(
    (line) => isRecord(line) && typeof line["id"] === "string",
  ).length;
  if (linesWithIds > 0 && linesWithIds !== lines.length) {
    throw new CartIntegrityError("Cart additions and updates cannot be mixed.");
  }

  if (linesWithIds === lines.length && lines.length > 0) {
    const request = decodeRequest(UpdateRequest, value);
    return {
      kind: "update",
      request,
    };
  }
  return {
    kind: "add",
    request: decodeRequest(AddRequest, value),
  };
}

export function requireCookieCartId(
  requestedCartId: string | undefined,
  cookieCartId: string | null | undefined,
) {
  if (!cookieCartId) {
    throw new CartIntegrityError("No cart exists for this browser.");
  }
  assertCartIdMatches(requestedCartId, cookieCartId);
  return cookieCartId;
}

export function assertCartIdMatches(
  requestedCartId: string | undefined,
  cookieCartId: string | null | undefined,
) {
  if (requestedCartId && requestedCartId !== cookieCartId) {
    throw new CartIntegrityError("The requested cart does not match this browser.");
  }
}

export function persistedProductId(attributes: readonly CartAttribute[]) {
  const productIds = attributes.filter(({ key }) => key === "_productId");
  const productId = productIds[0]?.value;
  if (productIds.length !== 1 || !productId) {
    throw new CartIntegrityError("The cart line is missing its verified product.");
  }
  return productId;
}

export function cartLineForUpdate(cart: CartSnapshot, lineId: string) {
  const line = cart.lines.find(({ id }) => id === lineId);
  if (!line) {
    throw new CartIntegrityError("The requested cart line does not exist.");
  }
  return line;
}

export function cartIdForVerifiedAdd(
  cartId: string | null | undefined,
  cart: CartSnapshot | undefined,
) {
  if (!cartId || !cart) return undefined;
  return cart.lines.some(({ quantity }) => quantity < 1)
    ? undefined
    : cartId;
}

export function rebuildLineAttributes(
  persistedAttributes: readonly CartAttribute[],
  verifiedAttributes: readonly CartAttribute[],
) {
  return [
    ...persistedAttributes.filter(({ key }) => !isReservedAttribute(key)),
    ...verifiedAttributes,
  ];
}

export function attributesForNewLine(
  requestedAttributes: readonly CartAttribute[],
  verifiedAttributes: readonly CartAttribute[],
) {
  return [
    ...requestedAttributes.filter(({ key }) => !isReservedAttribute(key)),
    ...verifiedAttributes,
  ];
}

export function validateVariantCandidate(
  candidate: VariantCandidate,
  sellingPlanId: string | undefined,
) {
  if (candidate.typeName !== "ProductVariant") {
    throw new CartIntegrityError("The selected merchandise is not a product variant.");
  }
  if (candidate.productId !== candidate.baseProductId) {
    throw new CartIntegrityError("The selected variant does not belong to this product.");
  }
  if (!candidate.availableForSale) {
    throw new CartIntegrityError("The selected variant is unavailable.");
  }
  if (candidate.requiresSellingPlan && !sellingPlanId) {
    throw new CartIntegrityError("Choose an available purchase plan.");
  }
  if (
    sellingPlanId &&
    !candidate.sellingPlanIds.includes(sellingPlanId)
  ) {
    throw new CartIntegrityError("The selected purchase plan is unavailable.");
  }
}

export function assertAddCapacity(
  cart: CartSnapshot | undefined,
  request: VerifiedAddRequest,
) {
  // Best-effort abuse control: Shopify cart mutations do not expose an atomic
  // compare-and-set, so concurrent requests can pass the same preflight read.
  const currentLines = cart?.lines.length ?? 0;
  const currentQuantity = cart?.totalQuantity ?? 0;
  const addedQuantity = request.lines.reduce(
    (total, line) => total + line.quantity,
    0,
  );
  if (currentLines + request.lines.length > MAX_CART_LINES) {
    throw new CartIntegrityError("This cart has reached its line limit.");
  }
  if (currentQuantity + addedQuantity > MAX_CART_TOTAL_QUANTITY) {
    throw new CartIntegrityError("This cart has reached its quantity limit.");
  }
}

export function assertUpdateCapacity(
  cart: CartSnapshot,
  updates: readonly { readonly id: string; readonly quantity: number }[],
) {
  // Best-effort for the same read-before-write reason as add capacity checks.
  const requestedQuantities = new Map(
    updates.map(({ id, quantity }) => [id, quantity]),
  );
  const nextTotal = cart.lines.reduce(
    (total, line) => total + (requestedQuantities.get(line.id) ?? line.quantity),
    0,
  );
  if (
    nextTotal > MAX_CART_TOTAL_QUANTITY &&
    nextTotal >= cart.totalQuantity
  ) {
    throw new CartIntegrityError("This cart has reached its quantity limit.");
  }
}

function decodeRequest<Decoded, Encoded>(
  schema: Schema.Schema<Decoded, Encoded>,
  value: unknown,
) {
  const decoded = Schema.decodeUnknownEither(schema)(value);
  if (Either.isLeft(decoded)) {
    throw new CartIntegrityError("The cart request is invalid.");
  }
  return decoded.right;
}

function isReservedAttribute(key: string) {
  return key === CHECKOUT_ARTWORK_NOTE.key || key === "_artworkUrl" || key === "_designId" ||
    key === "_lineCapability" || key === "_productId";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
