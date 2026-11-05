import "server-only";

import { safeErrorDetails } from "@forever-tee/contracts/diagnostics";

import {
  createCartServerHandlers,
  createCartCookie,
  createShopifyRouteHandler,
  getCartId,
  type ShopifyRouteJsonResult,
  type ShopifyRouteRedirectResult,
  type StorefrontClient,
} from "@shopify/hydrogen";
import { Effect } from "effect";

import { consolidateVariantUpdates } from "@/lib/cart-line-consolidation";

import {
  assertAddCapacity,
  assertCartIdMatches,
  assertUpdateCapacity,
  attributesForNewLine,
  cartIdForVerifiedAdd,
  cartLineForUpdate,
  CartIntegrityError,
  MAX_LINE_QUANTITY,
  type CartSnapshot,
  decodeCartLinesMutation,
  persistedProductId,
  rebuildLineAttributes,
  requireCookieCartId,
  type VerifiedAddRequest,
  type VerifiedUpdateRequest,
} from "@/lib/cart-integrity";
import {
  CART_FRAGMENT,
  CART_LINES_VARIANT_UPDATE_QUERY,
  EMPTY_CART_CREATE_QUERY,
} from "@/lib/cart-query";
import {
  CartDependencyError,
  readVerifiedCart,
  readVerifiedCartForAdd,
  verifyShopifyVariant,
} from "@/server/cart-integrity-storefront";
import { resolveVerifiedProductLine } from "@/server/cart-program";
import {
  assertSalesIntakeOpen,
  SalesIntakeDependencyError,
} from "@/server/sales-intake";
import {
  issueCartLineCapability,
  VariantMappingDependencyError,
} from "@/server/variant-mapping";

const baseCartHandlers = createCartServerHandlers({ fragment: CART_FRAGMENT });

const post = createShopifyRouteHandler(
  "/api/cart",
  "POST",
  async (context) => {
    const verification = createCartVerification(context.storefrontClient);
    let lineScopedFailure = false;
    try {
      if (!context.request.headers.get("content-type")?.includes("application/json")) {
        return await handleFormRequest(context, verification);
      }
      const payload: unknown = await context.request.clone().json();
      const mutation = decodeCartLinesMutation(payload);
      if (!mutation) return await baseCartHandlers.post(context);

      if (mutation.kind === "update") {
        const cartId = requireCookieCartId(
          mutation.request.cartId,
          getCartId(context.request),
        );
        const cart = await readVerifiedCart(context.storefrontClient, cartId);
        lineScopedFailure = true;
        const lines = await prepareUpdates(
          verification,
          cart,
          mutation.request,
        );
        return await applyPreparedUpdates(context, cartId, lines);
      }

      const cookieCartId = getCartId(context.request);
      assertCartIdMatches(mutation.request.cartId, cookieCartId);
      const cart = cookieCartId
        ? await readVerifiedCartForAdd(context.storefrontClient, cookieCartId)
        : undefined;
      const addCartId = cartIdForVerifiedAdd(cookieCartId, cart);
      const addCart = addCartId ? cart : undefined;
      lineScopedFailure = true;
      if (addCart) {
        const matchingUpdate = matchingAdditionUpdate(
          addCart,
          mutation.request,
        );
        if (matchingUpdate) {
          const lines = await prepareUpdates(
            verification,
            addCart,
            matchingUpdate,
          );
          return await applyPreparedUpdates(context, addCart.id, lines);
        }
      }
      const lines = await prepareAdditions(
        verification,
        addCart,
        mutation.request,
      );
      const headers = new Headers(context.request.headers);
      headers.delete("content-length");
      if (cookieCartId && !addCartId) removeCartCookie(headers);
      const enrichedRequest = new Request(context.request, {
        body: JSON.stringify({ lines }),
        headers,
      });
      return await baseCartHandlers.post({ ...context, request: enrichedRequest });
    } catch (error) {
      return await cartRequestFailure(context, error, lineScopedFailure);
    }
  },
);

export const cartHandlers = {
  get: baseCartHandlers.get,
  post,
};

async function handleFormRequest(context: {
  request: Request;
  storefrontClient: StorefrontClient;
}, verification: CartVerification) {
  const contentType = context.request.headers.get("content-type") ?? "";
  if (
    !contentType.includes("application/x-www-form-urlencoded") &&
    !contentType.includes("multipart/form-data")
  ) {
    return await baseCartHandlers.post(context);
  }

  const form = await context.request.clone().formData();
  const intent = formString(form, "intent");
  const merchandiseId = formString(form, "merchandiseId");
  if (intent === "add" || (!intent && merchandiseId)) {
    throw new CartIntegrityError(
      "Add this product from its verified bent.shop design page.",
    );
  }
  if (!intent || !["decrease", "increase", "remove", "set"].includes(intent)) {
    return await baseCartHandlers.post(context);
  }

  const cartId = requireCookieCartId(undefined, getCartId(context.request));
  const cart = await readVerifiedCart(context.storefrontClient, cartId);
  const lineId = formString(form, "lineId");
  if (!lineId) {
    throw new CartIntegrityError("The cart line is required.");
  }
  const line = cartLineForUpdate(cart, lineId);
  const requestedQuantity = parseFormQuantity(form);
  const nextQuantity = intent === "remove"
    ? 0
    : intent === "increase"
      ? line.quantity + 1
      : intent === "decrease"
        ? Math.max(0, line.quantity - 1)
        : requestedQuantity;
  if (nextQuantity === undefined || !Number.isInteger(nextQuantity)) {
    throw new CartIntegrityError("The cart quantity is invalid.");
  }
  if (nextQuantity > MAX_LINE_QUANTITY && nextQuantity >= line.quantity) {
    throw new CartIntegrityError("The cart line has reached its quantity limit.");
  }
  assertUpdateCapacity(cart, [{ id: lineId, quantity: nextQuantity }]);
  if (nextQuantity > line.quantity) await assertSalesOpenForCart();

  if (nextQuantity === 0) {
    form.set("lineId", lineId);
    if (intent === "increase" || intent === "decrease") {
      form.set("quantity", String(line.quantity));
    } else if (intent === "set") {
      form.set("quantity", "0");
    }
    const headers = new Headers(context.request.headers);
    headers.delete("content-length");
    headers.delete("content-type");
    clearNativeCartError(headers, context.request.url);
    const sanitizedRequest = new Request(context.request, { body: form, headers });
    return await baseCartHandlers.post({ ...context, request: sanitizedRequest });
  }

  const productId = persistedProductId(line.attributes);
  const verified = await verification.resolveProductLine(productId);
  if (!line.merchandiseId) {
    throw new CartIntegrityError("The cart line has invalid merchandise.");
  }
  await verification.verifyVariant(
    line.merchandiseId,
    verified.baseShopifyHandle,
    line.sellingPlanId,
  );
  const capability = await verification.issueCapability(
    productId,
    line.merchandiseId,
    nextQuantity,
  );
  const result = await context.storefrontClient.graphql(
    CART_LINES_VARIANT_UPDATE_QUERY,
    {
      variables: {
        cartId,
        lines: [{
          attributes: rebuildLineAttributes(
            line.attributes,
            withLineCapability(verified.attributes, capability),
          ),
          id: lineId,
          merchandiseId: line.merchandiseId,
          quantity: nextQuantity,
          ...(line.sellingPlanId
            ? { sellingPlanId: line.sellingPlanId }
            : {}),
        }],
      },
    },
  );
  if (result.errors) {
    throw new CartDependencyError("Shopify could not update the cart.");
  }
  const updatePayload = result.data.cartLinesUpdate;
  if (!updatePayload) {
    throw new CartDependencyError("Shopify returned no cart update.");
  }
  const userErrorMessage = updatePayload.userErrors
    .map(({ message }) => message)
    .join(" ");
  if (userErrorMessage) console.warn("[bent.shop cart] provider rejected mutation", { operation: "cart_mutation", code: "CART_REJECTED", errorCount: updatePayload.userErrors.length });
  const redirect: ShopifyRouteRedirectResult = {
    type: "redirect",
    location: userErrorMessage
      ? `/cart?cartError=${encodeURIComponent(userErrorMessage)}`
      : nativeRedirectLocation(context.request),
    headers: cartResponseHeaders(result.headers),
  };
  return redirect;
}

function matchingAdditionUpdate(
  cart: CartSnapshot,
  request: VerifiedAddRequest,
): VerifiedUpdateRequest | undefined {
  const addition = request.lines.length === 1 ? request.lines[0] : undefined;
  if (!addition) return undefined;
  const productId = requestedProductId(addition.attributes);
  const [matchingLine, ...duplicateLines] = cart.lines.filter((line) =>
    line.merchandiseId === addition.merchandiseId &&
    line.sellingPlanId === addition.sellingPlanId &&
    persistedProductIdOrUndefined(line.attributes) === productId
  );
  if (!matchingLine) return undefined;

  return {
    ...(request.cartId ? { cartId: request.cartId } : {}),
    lines: [{
      attributes: [],
      id: matchingLine.id,
      quantity: [matchingLine, ...duplicateLines].reduce(
        (quantity, line) => quantity + line.quantity,
        addition.quantity,
      ),
    }, ...duplicateLines.map((line) => ({
      attributes: [],
      id: line.id,
      quantity: 0,
    }))],
  };
}

type CartHandlerContext = Parameters<typeof baseCartHandlers.post>[0];

async function applyPreparedUpdates(
  context: CartHandlerContext,
  cartId: string,
  lines: Awaited<ReturnType<typeof prepareUpdates>>,
) {
  if (lines.some(({ quantity }) => quantity > 0)) {
    // Submit the combined quantity and absorbed lines together. A second
    // removal request could fail after the survivor had already been increased.
    const result = await context.storefrontClient.graphql(
      CART_LINES_VARIANT_UPDATE_QUERY,
      { variables: { cartId, lines } },
    );
    if (result.errors) {
      throw new CartDependencyError("Shopify could not update the cart.");
    }
    const payload = result.data.cartLinesUpdate;
    if (!payload) {
      throw new CartDependencyError("Shopify returned no cart update.");
    }
    const response: ShopifyRouteJsonResult<typeof payload> = {
      type: "json",
      data: payload,
      headers: cartResponseHeaders(result.headers),
    };
    return response;
  }

  const headers = new Headers(context.request.headers);
  headers.delete("content-length");
  const removalRequest = new Request(context.request, {
    body: JSON.stringify({ lines }),
    headers,
  });
  return await baseCartHandlers.post({ ...context, request: removalRequest });
}

function persistedProductIdOrUndefined(
  attributes: readonly { readonly key: string; readonly value: string }[],
) {
  try {
    return persistedProductId(attributes);
  } catch {
    return undefined;
  }
}

async function prepareAdditions(
  verification: CartVerification,
  cart: CartSnapshot | undefined,
  request: VerifiedAddRequest,
) {
  await assertSalesOpenForCart();
  assertAddCapacity(cart, request);
  return await Promise.all(
    request.lines.map(async (line) => {
      const productId = requestedProductId(line.attributes);
      const verified = await verification.resolveProductLine(productId);
      await verification.verifyVariant(
        line.merchandiseId,
        verified.baseShopifyHandle,
        line.sellingPlanId,
      );
      const capability = await verification.issueCapability(
        productId,
        line.merchandiseId,
        line.quantity,
      );
      return {
        attributes: attributesForNewLine(
          line.attributes,
          withLineCapability(verified.attributes, capability),
        ),
        merchandiseId: line.merchandiseId,
        quantity: line.quantity,
        ...(line.sellingPlanId ? { sellingPlanId: line.sellingPlanId } : {}),
      };
    }),
  );
}

async function prepareUpdates(
  verification: CartVerification,
  cart: CartSnapshot,
  request: VerifiedUpdateRequest,
) {
  assertUpdateCapacity(cart, request.lines);
  if (request.lines.some((line) =>
    line.quantity > cartLineForUpdate(cart, line.id).quantity
  )) {
    await assertSalesOpenForCart();
  }
  const updates = consolidateVariantUpdates(cart, request.lines);
  assertUpdateCapacity(cart, updates);
  return await Promise.all(
    updates.map(async (line) => {
      const current = cartLineForUpdate(cart, line.id);
      if (line.quantity === 0) {
        return { id: line.id, quantity: 0 };
      }

      const productId = persistedProductId(current.attributes);
      const verified = await verification.resolveProductLine(productId);
      const merchandiseId = line.merchandiseId ?? current.merchandiseId;
      if (!merchandiseId) {
        throw new CartIntegrityError("The cart line has invalid merchandise.");
      }
      const sellingPlanId = line.sellingPlanId === undefined
        ? current.sellingPlanId
        : line.sellingPlanId ?? undefined;
      await verification.verifyVariant(
        merchandiseId,
        verified.baseShopifyHandle,
        sellingPlanId,
      );
      const capability = await verification.issueCapability(
        productId,
        merchandiseId,
        line.quantity,
      );
      return {
        attributes: rebuildLineAttributes(
          current.attributes,
          withLineCapability(verified.attributes, capability),
        ),
        id: line.id,
        merchandiseId,
        quantity: line.quantity,
        ...(line.sellingPlanId === null
          ? { sellingPlanId: null }
          : sellingPlanId
            ? { sellingPlanId }
            : {}),
      };
    }),
  );
}

async function assertSalesOpenForCart() {
  try {
    await assertSalesIntakeOpen();
  } catch (error) {
    if (error instanceof SalesIntakeDependencyError) {
      throw new CartDependencyError(error.message);
    }
    throw new CartIntegrityError(
      error instanceof Error ? error.message : "Orders are temporarily paused.",
    );
  }
}

async function resolveProductLine(productId: string) {
  try {
    return await Effect.runPromise(resolveVerifiedProductLine(productId));
  } catch (error) {
    if (isRecord(error) && error["_tag"] === "DependencyUnavailable") {
      throw new CartDependencyError("Product storage is unavailable.");
    }
    throw error;
  }
}

type VerifiedProductLine = Awaited<ReturnType<typeof resolveProductLine>>;

interface CartVerification {
  readonly issueCapability: (
    productId: string,
    merchandiseId: string,
    quantity: number,
  ) => Promise<string>;
  readonly resolveProductLine: (productId: string) => Promise<VerifiedProductLine>;
  readonly verifyVariant: (
    merchandiseId: string,
    baseShopifyHandle: string,
    sellingPlanId: string | undefined,
  ) => Promise<void>;
}

function createCartVerification(
  storefrontClient: StorefrontClient,
): CartVerification {
  const productLines = new Map<string, Promise<VerifiedProductLine>>();
  const variants = new Map<string, Promise<void>>();
  const capabilities = new Map<string, Promise<string>>();
  return {
    issueCapability(productId, merchandiseId, quantity) {
      const key = JSON.stringify([productId, merchandiseId, quantity]);
      const pending = capabilities.get(key) ?? issueCartLineCapability(
        productId,
        merchandiseId,
        quantity,
      );
      capabilities.set(key, pending);
      return pending;
    },
    resolveProductLine(productId) {
      const pending = productLines.get(productId) ?? resolveProductLine(productId);
      productLines.set(productId, pending);
      return pending;
    },
    verifyVariant(merchandiseId, baseShopifyHandle, sellingPlanId) {
      const key = JSON.stringify([
        merchandiseId,
        baseShopifyHandle,
        sellingPlanId ?? null,
      ]);
      const pending = variants.get(key) ?? verifyShopifyVariant(
        storefrontClient,
        merchandiseId,
        baseShopifyHandle,
        sellingPlanId,
      );
      variants.set(key, pending);
      return pending;
    },
  };
}

function withLineCapability(
  attributes: readonly { readonly key: string; readonly value: string }[],
  capability: string,
) {
  return [
    ...attributes.filter(({ key }) => key !== "_lineCapability"),
    { key: "_lineCapability", value: capability },
  ];
}

function requestedProductId(attributes: readonly { key: string; value: string }[]) {
  const productIds = attributes.filter(({ key }) => key === "_productId");
  const productId = productIds[0]?.value;
  if (productIds.length !== 1 || !productId) {
    throw new CartIntegrityError("A verified bent.shop product is required.");
  }
  return productId;
}

function formString(form: FormData, key: string) {
  const value = form.get(key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseFormQuantity(form: FormData) {
  const rawQuantity = formString(form, "quantity");
  if (!rawQuantity || !/^\d+$/.test(rawQuantity)) return undefined;
  const quantity = Number(rawQuantity);
  return Number.isSafeInteger(quantity) ? quantity : undefined;
}

function clearNativeCartError(headers: Headers, requestUrl: string) {
  const referer = headers.get("referer");
  if (!referer) return;
  try {
    const refererUrl = new URL(referer);
    if (refererUrl.origin !== new URL(requestUrl).origin) return;
    refererUrl.searchParams.delete("cartError");
    headers.set("referer", refererUrl.toString());
  } catch {
    headers.delete("referer");
  }
}

function removeCartCookie(headers: Headers) {
  const cookie = headers.get("cookie");
  if (!cookie) return;
  const remaining = cookie.split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part.split("=", 1)[0] !== "cart");
  if (remaining.length > 0) {
    headers.set("cookie", remaining.join("; "));
  } else {
    headers.delete("cookie");
  }
}

function nativeRedirectLocation(request: Request) {
  const referer = request.headers.get("referer");
  if (!referer) return "/cart";
  try {
    const refererUrl = new URL(referer);
    if (refererUrl.origin !== new URL(request.url).origin) return "/cart";
    refererUrl.searchParams.delete("cartError");
    return `${refererUrl.pathname}${refererUrl.search}${refererUrl.hash}`;
  } catch {
    return "/cart";
  }
}

function cartResponseHeaders(headers: HeadersInit | undefined) {
  const responseHeaders = new Headers(headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  responseHeaders.delete("transfer-encoding");
  return responseHeaders;
}

async function cartRequestFailure(
  context: CartFailureContext,
  error: unknown,
  lineScoped: boolean,
): Promise<
  ShopifyRouteJsonResult<Record<string, unknown>> | ShopifyRouteRedirectResult
> {
  const unavailable = error instanceof CartDependencyError ||
    error instanceof VariantMappingDependencyError ||
    (isRecord(error) && error["_tag"] === "DependencyUnavailable");
  const requestId = crypto.randomUUID();
  const log = unavailable ? console.error : console.warn;
  log("[bent.shop cart] request failed", {
    requestId, operation: "cart_mutation", code: unavailable ? "CART_DEPENDENCY_UNAVAILABLE" : "INVALID_CART_PRODUCT",
    ...safeErrorDetails(error),
  });
  const message = errorMessage(error);
  if (!context.request.headers.get("content-type")?.includes("application/json")) {
    return {
      type: "redirect",
      location: `/cart?cartError=${encodeURIComponent(message)}`,
      headers: { "x-request-id": requestId },
    };
  }
  const recovered = await recoverCartForFailure(context);
  return {
    type: "json",
    data: {
      cart: recovered?.cart ?? null,
      detail: { requestId },
      userErrors: [{
        code: unavailable
          ? "CART_DEPENDENCY_UNAVAILABLE"
          : "INVALID_CART_PRODUCT",
        ...(lineScoped ? { field: ["lines", "0"] } : {}),
        message,
      }],
      warnings: [],
    },
    headers: { ...Object.fromEntries(new Headers(recovered?.headers)), "x-request-id": requestId },
  };
}

async function recoverCartForFailure(
  context: CartFailureContext,
) {
  try {
    const existingCartId = getCartId(context.request);
    if (existingCartId) {
      const result = await baseCartHandlers.get(context);
      if (result.data.cart) {
        return { cart: result.data.cart, headers: result.headers };
      }
    }
    const result = await context.storefrontClient.graphql(
      EMPTY_CART_CREATE_QUERY,
      { variables: { input: {} } },
    );
    const cart = result.data?.cartCreate?.cart;
    if (result.errors || !cart) return undefined;
    const headers = cartResponseHeaders(result.headers);
    headers.append("set-cookie", createCartCookie(cart.id));
    return { cart, headers };
  } catch {
    return undefined;
  }
}

type CartFailureContext = Parameters<typeof baseCartHandlers.get>[0] & {
  readonly request: Request;
};

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error["message"] === "string") {
    return error["message"];
  }
  return "The cart request could not be verified.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
