import { safeErrorDetails } from "@forever-tee/contracts/diagnostics";
import { OrderDeliveryAddress, type BaseProductSlug } from "@forever-tee/contracts";
import { Either, Schema } from "effect";

import {
  baseProductSpecification,
  LAUNCH_BASE_PRODUCTS,
  launchProductColor,
  type BaseProductSpecification,
  type LaunchProductColor,
} from "./base-product-specifications";
import type { IntegrationEnv } from "./integration-config";
import { requireShopifyAdminClientConfig } from "./integration-config";

const SHOPIFY_ADMIN_API_VERSION = "2026-07";
const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

export const BASE_PRODUCT_QUERY = `
  query BentShirtBaseProduct($identifier: ProductIdentifierInput!) {
    product: productByIdentifier(identifier: $identifier) {
      id
      handle
      title
      variants(first: 100) {
        nodes {
          id
          title
          availableForSale
          selectedOptions { name value }
          sku
        }
        pageInfo { hasNextPage }
      }
    }
  }
`;

const PAID_ORDER_QUERY = `
  query BentShirtPaidOrder($id: ID!) {
    order(id: $id) {
      id
      name
      updatedAt
      cancelledAt
      edited
      displayFinancialStatus
      email
      currentTotalPriceSet {
        presentmentMoney { amount currencyCode }
      }
      risk {
        recommendation
        assessments { riskLevel }
      }
      shippingAddress {
        firstName
        lastName
        company
        address1
        address2
        city
        province
        provinceCode
        zip
        country
        countryCodeV2
        phone
        validationResultSummary
      }
      lineItems(first: 250) {
        nodes {
          id
          currentQuantity
          quantity
          originalUnitPriceSet {
            presentmentMoney { amount currencyCode }
          }
          variant { id }
          customAttributes { key value }
        }
        pageInfo { hasNextPage }
      }
    }
  }
`;

export const FULFILMENT_ORDERS_QUERY = `
  query BentShirtFulfilmentOrders($id: ID!) {
    order(id: $id) {
      id
      fulfillmentOrders(first: 20) {
        nodes {
          id
          status
          lineItems(first: 250) {
            nodes {
              id
              remainingQuantity
              lineItem { id }
            }
            pageInfo { hasNextPage }
          }
        }
        pageInfo { hasNextPage }
      }
    }
  }
`;

export const FULFILMENT_CREATE_MUTATION = `
  mutation BentShirtCreateFulfilment($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment { id }
      userErrors { field message }
    }
  }
`;

export class ShopifyAdminAuthenticationError extends Error {}
export class ShopifyAdminContractError extends Error {}
export class ShopifyAdminDependencyError extends Error {}
export class ShopifyAdminRateLimitError extends Error {}
export class ShopifyAdminAmbiguousMutationError extends Error {}

interface CachedAccessToken {
  readonly accessToken: string;
  readonly cacheKey: string;
  readonly expiresAt: number;
  readonly scopes: readonly string[];
}

let cachedAccessToken: CachedAccessToken | undefined;

interface SelectedOption {
  name: string;
  value: string;
}

interface ShopifyBaseVariant {
  readonly availableForSale: boolean;
  readonly color: LaunchProductColor;
  readonly id: string;
  readonly size: string;
  readonly sku: string | null;
  readonly title: string;
}

export interface ShopifyBaseProduct {
  readonly baseProductId: string;
  readonly baseProductSlug: BaseProductSlug;
  readonly handle: string;
  readonly id: string;
  readonly sourceUrl: string;
  readonly title: string;
  readonly variants: readonly ShopifyBaseVariant[];
}

type ShopifyFraudResult =
  | "pending"
  | "accept"
  | "none"
  | "cancel"
  | "investigate";

type ShopifyAddressValidationResult =
  | "pending"
  | "no_issues"
  | "warning"
  | "error";

interface ShopifyDeliveryAddress {
  readonly address1: string;
  readonly address2: string | null;
  readonly city: string;
  readonly company: string | null;
  readonly country: string;
  readonly countryCode: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly phone: string | null;
  readonly province: string | null;
  readonly provinceCode: string | null;
  readonly zip: string;
}

export interface ShopifyPaidOrderLine {
  readonly currentQuantity: number;
  readonly id: string;
  readonly lineCapability: string;
  readonly originalQuantity: number;
  readonly retailCurrencyCode: string;
  readonly retailPriceMinorUnits: number;
  readonly shopifyVariantId: string;
}

export interface ShopifyPaidOrder {
  readonly address: ShopifyDeliveryAddress | null;
  readonly addressValidationResult: ShopifyAddressValidationResult;
  readonly cancelledAt: string | null;
  readonly currencyCode: string;
  readonly edited: boolean;
  readonly financialStatus: string;
  readonly fraudResult: ShopifyFraudResult;
  readonly id: string;
  readonly lines: readonly ShopifyPaidOrderLine[];
  readonly name: string;
  readonly totalMinorUnits: number;
  readonly updatedAt: string;
}

export interface ShopifyShipmentLine {
  readonly quantity: number;
  readonly shopifyLineItemId: string;
}

export interface ShopifyShipment {
  readonly carrier: string;
  readonly lines: readonly ShopifyShipmentLine[];
  readonly trackingNumber: string;
  readonly trackingUrl: string;
}

export interface ShopifyFulfilmentResult {
  readonly id: string;
}

export function makeShopifyAdminClient(
  env: IntegrationEnv,
  fetcher: typeof fetch = fetch,
) {
  const config = requireShopifyAdminClientConfig(env);
  const sourceUrl =
    `https://${config.storeDomain}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`;
  return {
    async loadPaidOrderDeadline(orderId: string, now: number): Promise<number> {
      const accessToken = await getAccessToken(config, fetcher, `${config.storeDomain}\u0000${config.clientId}`, "read_orders");
      const response = await requestGraphql(sourceUrl, accessToken, fetcher, `query BentShirtPaymentDeadline($id: ID!) {
        order(id: $id) { id displayFinancialStatus transactions(first: 100) { kind status createdAt amountSet { presentmentMoney { amount currencyCode } } } currentTotalPriceSet { presentmentMoney { amount currencyCode } } }
      }`, {id: orderId});
      const payload: unknown = await parseShopifyJsonResponse(response, "payment deadline", false);
      if (!isRecord(payload) || hasGraphqlErrors(payload) || !isRecord(payload["data"]) || !isRecord(payload["data"]["order"])) throw invalidContract("payment deadline");
      const order = payload["data"]["order"];
      const transactions = order["transactions"];
      if (order["id"] !== orderId || order["displayFinancialStatus"] !== "PAID" || !Array.isArray(transactions) || transactions.length >= 100) throw invalidContract("payment deadline");
      const total = parseCurrentTotal(order["currentTotalPriceSet"]);
      let paid = 0, paidAt = 0;
      for (const transaction of transactions) {
        if (!isRecord(transaction)) throw invalidContract("payment transaction");
        if (transaction["status"] !== "SUCCESS" || (transaction["kind"] !== "SALE" && transaction["kind"] !== "CAPTURE")) continue;
        const amount = parseCurrentTotal(transaction["amountSet"]);
        const rawCreatedAt = transaction["createdAt"];
        if (typeof rawCreatedAt !== "string") throw invalidContract("payment transaction time");
        const createdAt = Date.parse(rawCreatedAt);
        if (amount.currencyCode !== "AUD" || !Number.isFinite(createdAt) || createdAt <= 0 || createdAt > now + 60_000) throw invalidContract("payment transaction");
        paid += amount.totalMinorUnits;
        if (amount.totalMinorUnits > 0) paidAt = Math.max(paidAt, createdAt);
      }
      if (!paidAt || total.currencyCode !== "AUD" || paid !== total.totalMinorUnits) throw invalidContract("paid total");
      return paidAt + 3_600_000;
    },
    async loadManagedOrder(orderId: string) {
      const accessToken = await getAccessToken(config, fetcher, `${config.storeDomain}\u0000${config.clientId}`, "read_orders");
      const response = await requestGraphql(sourceUrl, accessToken, fetcher, `query BentShirtManagedOrder($id: ID!) {
        order(id: $id) { id cancelledAt displayFinancialStatus shippingAddress {
          firstName lastName address1 address2 city provinceCode zip countryCodeV2 phone validationResultSummary
        } }
      }`, {id: orderId});
      const payload: unknown = await parseShopifyJsonResponse(response, "managed order", false);
      if (!isRecord(payload) || hasGraphqlErrors(payload) || !isRecord(payload["data"]) || !isRecord(payload["data"]["order"])) throw invalidContract("managed order");
      const order = payload["data"]["order"];
      if (order["id"] !== orderId) throw invalidContract("managed order identity");
      const raw = order["shippingAddress"];
      const address = Schema.decodeUnknownEither(OrderDeliveryAddress)(isRecord(raw) ? {...raw, countryCode: raw["countryCodeV2"], address2: raw["address2"] ?? "", phone: raw["phone"] ?? ""} : null);
      return {cancelledAt: nullableIsoDateTime(order["cancelledAt"]), financialStatus: nonEmptyString(order["displayFinancialStatus"]), address: Either.isRight(address) ? address.right : null, addressValidationResult: isRecord(raw) ? addressValidationResult(raw["validationResultSummary"]) ?? "pending" : "pending"};
    },
    async updateOrderAddress(orderId: string, address: OrderDeliveryAddress): Promise<void> {
      const payload = await managementMutation(`mutation BentShirtUpdateAddress($input: OrderInput!) {
        orderUpdate(input: $input) { order { id } userErrors { field message } }
      }`, { input: { id: orderId, shippingAddress: { firstName: address.firstName, lastName: address.lastName, address1: address.address1, address2: address.address2, city: address.city, zip: address.zip, phone: address.phone, country: "Australia", province: address.provinceCode } } }, "orderUpdate");
      if (!isRecord(payload["order"]) || payload["order"]["id"] !== orderId) throw new ShopifyAdminAmbiguousMutationError("Order address update could not be verified.");
    },
    async cancelAndRefundOrder(orderId: string): Promise<string> {
      const payload = await managementMutation(`mutation BentShirtCancelOrder($orderId: ID!) {
        orderCancel(orderId: $orderId, reason: CUSTOMER, notifyCustomer: true, restock: true,
          refundMethod: {originalPaymentMethodsRefund: true}) {
          job { id done } orderCancelUserErrors { field message code }
        }
      }`, { orderId }, "orderCancel", "orderCancelUserErrors");
      if (!isRecord(payload["job"]) || !gid(payload["job"]["id"], "Job")) throw new ShopifyAdminAmbiguousMutationError("Cancellation acknowledgement is unavailable.");
      const jobId = payload["job"]["id"];
      if (typeof jobId !== "string") throw invalidContract("cancellation job");
      return jobId;
    },
    async loadRefundState(orderId: string) {
      const accessToken = await getAccessToken(config, fetcher, `${config.storeDomain}\u0000${config.clientId}`, "read_orders");
      const response = await requestGraphql(sourceUrl, accessToken, fetcher, `query BentShirtRefundState($id: ID!) {
        order(id: $id) { id cancelledAt displayFinancialStatus totalRefundedSet { presentmentMoney { amount currencyCode } } }
      }`, {id: orderId});
      const payload: unknown = await parseShopifyJsonResponse(response, "refund state", false);
      if (!isRecord(payload) || hasGraphqlErrors(payload) || !isRecord(payload["data"]) || !isRecord(payload["data"]["order"])) throw invalidContract("refund state");
      const order = payload["data"]["order"];
      if (order["id"] !== orderId) throw invalidContract("refund identity");
      const refunded = parseCurrentTotal(order["totalRefundedSet"]);
      return {cancelledAt: nullableIsoDateTime(order["cancelledAt"]), financialStatus: nonEmptyString(order["displayFinancialStatus"]), refundedMinorUnits: refunded.totalMinorUnits, currencyCode: refunded.currencyCode};
    },
    async loadBaseProduct(): Promise<ShopifyBaseProduct> {
      return loadProduct(baseProductSpecification("staple-tee"));
    },
    async loadBaseProductForSlug(
      slug: BaseProductSlug,
    ): Promise<ShopifyBaseProduct> {
      return loadProduct(baseProductSpecification(slug));
    },
    async loadLaunchBaseProducts(): Promise<readonly ShopifyBaseProduct[]> {
      const products: ShopifyBaseProduct[] = [];
      for (const specification of LAUNCH_BASE_PRODUCTS) {
        products.push(await loadProduct(specification));
      }
      return products;
    },
    async loadPaidOrder(orderId: string): Promise<ShopifyPaidOrder> {
      if (!/^gid:\/\/shopify\/Order\/[0-9]+$/u.test(orderId)) {
        throw new ShopifyAdminContractError("The Shopify order ID is invalid.");
      }
      const cacheKey = `${config.storeDomain}\u0000${config.clientId}`;
      let accessToken = await getAccessToken(
        config,
        fetcher,
        cacheKey,
        "read_orders",
      );
      let response = await requestGraphql(
        sourceUrl,
        accessToken,
        fetcher,
        PAID_ORDER_QUERY,
        { id: orderId },
      );
      if (response.status === 401 || response.status === 403) {
        cachedAccessToken = undefined;
        accessToken = await getAccessToken(
          config,
          fetcher,
          cacheKey,
          "read_orders",
        );
        response = await requestGraphql(
          sourceUrl,
          accessToken,
          fetcher,
          PAID_ORDER_QUERY,
          { id: orderId },
        );
      }
      return parsePaidOrderResponse(response, orderId);
    },
    async createFulfilment(
      orderId: string,
      shipment: ShopifyShipment,
    ): Promise<ShopifyFulfilmentResult> {
      validateShipment(orderId, shipment);
      const cacheKey = `${config.storeDomain}\u0000${config.clientId}`;
      const requiredScope = "write_merchant_managed_fulfillment_orders";
      let accessToken = await getAccessToken(
        config,
        fetcher,
        cacheKey,
        requiredScope,
      );
      let orderResponse = await requestGraphql(
        sourceUrl,
        accessToken,
        fetcher,
        FULFILMENT_ORDERS_QUERY,
        { id: orderId },
      );
      if (orderResponse.status === 401 || orderResponse.status === 403) {
        cachedAccessToken = undefined;
        accessToken = await getAccessToken(
          config,
          fetcher,
          cacheKey,
          requiredScope,
        );
        orderResponse = await requestGraphql(
          sourceUrl,
          accessToken,
          fetcher,
          FULFILMENT_ORDERS_QUERY,
          { id: orderId },
        );
      }
      const fulfillment = await parseFulfilmentOrdersResponse(
        orderResponse,
        orderId,
        shipment.lines,
      );
      const mutationResponse = await requestGraphql(
        sourceUrl,
        accessToken,
        fetcher,
        FULFILMENT_CREATE_MUTATION,
        {
          fulfillment: {
            lineItemsByFulfillmentOrder: fulfillment,
            notifyCustomer: true,
            trackingInfo: shipment.carrier.trim().toUpperCase().replaceAll(" ", "_") === "AUSTRALIA_POST"
              ? {
                  company: "Australia Post",
                  number: shipment.trackingNumber,
                  url: `https://auspost.com.au/track/${encodeURIComponent(shipment.trackingNumber)}`,
                }
              : {
                  company: shipment.carrier,
                  number: shipment.trackingNumber,
                  url: shipment.trackingUrl,
                },
          },
        },
        true,
      );
      return parseFulfilmentCreateResponse(mutationResponse);
    },
  };

  async function managementMutation(query: string, variables: Record<string, unknown>, field: string, errorField = "userErrors") {
    const accessToken = await getAccessToken(config, fetcher, `${config.storeDomain}\u0000${config.clientId}`, "write_orders");
    const response = await requestGraphql(sourceUrl, accessToken, fetcher, query, variables, true);
    const payload: unknown = await parseShopifyJsonResponse(response, "order management", true);
    if (!isRecord(payload) || hasGraphqlErrors(payload) || !isRecord(payload["data"]) || !isRecord(payload["data"][field])) throw new ShopifyAdminAmbiguousMutationError("Order management response is unavailable.");
    const result = payload["data"][field];
    if (!Array.isArray(result[errorField])) throw new ShopifyAdminAmbiguousMutationError("Order management acknowledgement is invalid.");
    if (result[errorField].length > 0) throw new ShopifyAdminContractError("Shopify rejected the order change.");
    return result;
  }

  async function loadProduct(
    specification: BaseProductSpecification,
  ): Promise<ShopifyBaseProduct> {
      const cacheKey = `${config.storeDomain}\u0000${config.clientId}`;
      let accessToken = await getAccessToken(
        config,
        fetcher,
        cacheKey,
        "read_products",
      );
      let response = await requestBaseProduct(
        sourceUrl,
        accessToken,
        fetcher,
        specification.shopifyHandle,
      );
      if (response.status === 401 || response.status === 403) {
        cachedAccessToken = undefined;
        accessToken = await getAccessToken(
          config,
          fetcher,
          cacheKey,
          "read_products",
        );
        response = await requestBaseProduct(
          sourceUrl,
          accessToken,
          fetcher,
          specification.shopifyHandle,
        );
      }
      return parseBaseProductResponse(response, sourceUrl, specification);
  }
}

export function resetShopifyAdminAccessTokenCache() {
  cachedAccessToken = undefined;
}

function hasScope(scopes: readonly string[], requiredScope: string) {
  // Shopify returns write scopes without their implied read counterparts.
  // https://shopify.dev/docs/api/usage/access-scopes
  return scopes.includes(requiredScope) || (
    requiredScope.startsWith("read_") &&
    scopes.includes(`write_${requiredScope.slice("read_".length)}`)
  );
}

async function getAccessToken(
  config: ReturnType<typeof requireShopifyAdminClientConfig>,
  fetcher: typeof fetch,
  cacheKey: string,
  requiredScope: string,
) {
  if (cachedAccessToken?.cacheKey === cacheKey &&
      cachedAccessToken.expiresAt - Date.now() > TOKEN_EXPIRY_BUFFER_MS &&
      hasScope(cachedAccessToken.scopes, requiredScope)) {
    return cachedAccessToken.accessToken;
  }
  const tokenUrl = `https://${config.storeDomain}/admin/oauth/access_token`;
  let response: Response;
  try {
    response = await fetcher(tokenUrl, {
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "client_credentials",
      }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    logRequestFailure("token", error);
    throw new ShopifyAdminDependencyError("Shopify Admin is unavailable.");
  }
  if (response.status === 401 || response.status === 403) {
    throw new ShopifyAdminAuthenticationError(
      "Shopify rejected the configured client credentials.",
    );
  }
  if (response.status === 429) {
    throw new ShopifyAdminRateLimitError(
      "Shopify rate limited the access-token request.",
    );
  }
  if (!response.ok) {
    throw new ShopifyAdminDependencyError(
      `Shopify access-token request failed with status ${String(response.status)}.`,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw invalidContract("access-token response");
  }
  if (!isRecord(payload)) throw invalidContract("access-token response");
  const accessToken = nonEmptyString(payload["access_token"]);
  const scope = nonEmptyString(payload["scope"]);
  const expiresIn = payload["expires_in"];
  if (!accessToken || !scope || typeof expiresIn !== "number" ||
      !Number.isSafeInteger(expiresIn) || expiresIn <= 0) {
    throw invalidContract("access-token response");
  }
  const scopes = scope.split(",").map((value) => value.trim());
  if (!hasScope(scopes, requiredScope)) {
    throw new ShopifyAdminAuthenticationError(
      `Shopify did not grant ${requiredScope} access.`,
    );
  }
  cachedAccessToken = {
    accessToken,
    cacheKey,
    expiresAt: Date.now() + expiresIn * 1_000,
    scopes,
  };
  return accessToken;
}

async function requestBaseProduct(
  sourceUrl: string,
  accessToken: string,
  fetcher: typeof fetch,
  handle: string,
) {
  return requestGraphql(
    sourceUrl,
    accessToken,
    fetcher,
    BASE_PRODUCT_QUERY,
    { identifier: { handle } },
  );
}

async function requestGraphql(
  sourceUrl: string,
  accessToken: string,
  fetcher: typeof fetch,
  query: string,
  variables: Record<string, unknown>,
  mutation = false,
) {
  let response: Response;
  try {
    response = await fetcher(sourceUrl, {
      body: JSON.stringify({ query, variables }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    logRequestFailure("GraphQL", error);
    if (mutation) {
      throw new ShopifyAdminAmbiguousMutationError(
        "The Shopify fulfilment result is unknown.",
      );
    }
    throw new ShopifyAdminDependencyError("Shopify Admin is unavailable.");
  }
  return response;
}

async function parseFulfilmentOrdersResponse(
  response: Response,
  expectedOrderId: string,
  requestedLines: readonly ShopifyShipmentLine[],
) {
  const payload = await parseShopifyJsonResponse(
    response,
    "fulfilment orders",
    false,
  );
  if (!isRecord(payload) || hasGraphqlErrors(payload) ||
      !isRecord(payload["data"]) || !isRecord(payload["data"]["order"])) {
    throw invalidContract("fulfilment orders");
  }
  const order = payload["data"]["order"];
  if (gid(order["id"], "Order") !== expectedOrderId ||
      !isRecord(order["fulfillmentOrders"])) {
    throw invalidContract("fulfilment orders");
  }
  const connection = order["fulfillmentOrders"];
  if (!Array.isArray(connection["nodes"]) ||
      !isRecord(connection["pageInfo"]) ||
      connection["pageInfo"]["hasNextPage"] !== false) {
    throw invalidContract("fulfilment orders");
  }
  const available = new Map<string, {
    readonly fulfilmentOrderId: string;
    readonly fulfilmentOrderLineItemId: string;
    readonly remainingQuantity: number;
  }>();
  for (const value of connection["nodes"]) {
    if (!isRecord(value) ||
        !isRecord(value["lineItems"]) ||
        !Array.isArray(value["lineItems"]["nodes"]) ||
        !isRecord(value["lineItems"]["pageInfo"]) ||
        value["lineItems"]["pageInfo"]["hasNextPage"] !== false) {
      throw invalidContract("fulfilment order lines");
    }
    const fulfilmentOrderId = gid(value["id"], "FulfillmentOrder");
    const status = nonEmptyString(value["status"]);
    if (!fulfilmentOrderId || !status ||
        !["OPEN", "IN_PROGRESS", "SCHEDULED"].includes(status)) {
      continue;
    }
    for (const line of value["lineItems"]["nodes"]) {
      if (!isRecord(line) || !isRecord(line["lineItem"])) {
        throw invalidContract("fulfilment order line");
      }
      const shopifyLineItemId = gid(line["lineItem"]["id"], "LineItem");
      const fulfilmentOrderLineItemId = gid(
        line["id"],
        "FulfillmentOrderLineItem",
      );
      const remainingQuantity = nonNegativeInteger(line["remainingQuantity"]);
      if (!shopifyLineItemId || !fulfilmentOrderLineItemId ||
          remainingQuantity === undefined) {
        throw invalidContract("fulfilment order line identity");
      }
      if (remainingQuantity === 0) continue;
      if (available.has(shopifyLineItemId)) {
        throw invalidContract("fulfilment order line identity");
      }
      available.set(shopifyLineItemId, {
        fulfilmentOrderId,
        fulfilmentOrderLineItemId,
        remainingQuantity,
      });
    }
  }
  const grouped = new Map<string, {
    readonly id: string;
    readonly quantity: number;
  }[]>();
  for (const requested of requestedLines) {
    const selected = available.get(requested.shopifyLineItemId);
    if (!selected || selected.remainingQuantity < requested.quantity) {
      throw new ShopifyAdminContractError(
        "Shopify does not have the requested fulfilment quantity.",
      );
    }
    const group = grouped.get(selected.fulfilmentOrderId) ?? [];
    group.push({
      id: selected.fulfilmentOrderLineItemId,
      quantity: requested.quantity,
    });
    grouped.set(selected.fulfilmentOrderId, group);
  }
  // fulfillmentCreate validates that the exact fulfilment orders share a
  // location. Reading Location separately requires unrelated read_locations.
  if (grouped.size === 0) {
    throw new ShopifyAdminContractError(
      "The shipment has no Shopify fulfilment lines.",
    );
  }
  return Array.from(grouped, ([fulfillmentOrderId, lines]) => ({
    fulfillmentOrderId,
    fulfillmentOrderLineItems: lines,
  }));
}

async function parseFulfilmentCreateResponse(response: Response) {
  const payload = await parseShopifyJsonResponse(
    response,
    "create fulfilment",
    true,
  );
  if (!isRecord(payload) || hasGraphqlErrors(payload) ||
      !isRecord(payload["data"]) ||
      !isRecord(payload["data"]["fulfillmentCreate"])) {
    throw new ShopifyAdminAmbiguousMutationError(
      "The Shopify fulfilment response is invalid.",
    );
  }
  const result = payload["data"]["fulfillmentCreate"];
  if (!Array.isArray(result["userErrors"])) {
    throw new ShopifyAdminAmbiguousMutationError(
      "The Shopify fulfilment response is invalid.",
    );
  }
  if (result["userErrors"].length > 0) {
    throw new ShopifyAdminContractError(
      "Shopify rejected the fulfilment request.",
    );
  }
  if (!isRecord(result["fulfillment"])) {
    throw new ShopifyAdminAmbiguousMutationError(
      "The Shopify fulfilment response has no fulfilment.",
    );
  }
  const id = gid(result["fulfillment"]["id"], "Fulfillment");
  if (!id) {
    throw new ShopifyAdminAmbiguousMutationError(
      "The Shopify fulfilment response has an invalid ID.",
    );
  }
  return { id };
}

async function parseShopifyJsonResponse(
  response: Response,
  operation: string,
  mutation: boolean,
) {
  if (response.status === 401 || response.status === 403) {
    throw new ShopifyAdminAuthenticationError(
      "Shopify rejected the configured Admin token.",
    );
  }
  if (response.status === 429) {
    throw new ShopifyAdminRateLimitError(
      `Shopify rate limited ${operation}.`,
    );
  }
  if (!response.ok) {
    if (mutation && response.status >= 500) {
      throw new ShopifyAdminAmbiguousMutationError(
        "The Shopify fulfilment result is unknown.",
      );
    }
    throw new ShopifyAdminDependencyError(
      `Shopify ${operation} failed with status ${String(response.status)}.`,
    );
  }
  try {
    return await response.json();
  } catch {
    if (mutation) {
      throw new ShopifyAdminAmbiguousMutationError(
        "The Shopify fulfilment response is invalid.",
      );
    }
    throw invalidContract(operation);
  }
}

function validateShipment(orderId: string, shipment: ShopifyShipment) {
  if (!/^gid:\/\/shopify\/Order\/[0-9]+$/u.test(orderId) ||
      shipment.lines.length === 0 || shipment.lines.length > 10 ||
      shipment.lines.some((line) =>
        !/^gid:\/\/shopify\/LineItem\/[0-9]+$/u.test(line.shopifyLineItemId) ||
        !Number.isSafeInteger(line.quantity) || line.quantity <= 0
      ) || !shipment.carrier.trim() || !shipment.trackingNumber.trim()) {
    throw new ShopifyAdminContractError("The shipment input is invalid.");
  }
  let trackingUrl: URL;
  try {
    trackingUrl = new URL(shipment.trackingUrl);
  } catch {
    throw new ShopifyAdminContractError("The tracking URL is invalid.");
  }
  if (trackingUrl.protocol !== "https:") {
    throw new ShopifyAdminContractError("The tracking URL is invalid.");
  }
}

async function parseBaseProductResponse(
  response: Response,
  sourceUrl: string,
  specification: BaseProductSpecification,
) {
      if (response.status === 401 || response.status === 403) {
        throw new ShopifyAdminAuthenticationError(
          "Shopify rejected the configured Admin token.",
        );
      }
      if (response.status === 429) {
        throw new ShopifyAdminRateLimitError(
          "Shopify rate limited the product request.",
        );
      }
      if (!response.ok) {
        throw new ShopifyAdminDependencyError(
          `Shopify Admin request failed with status ${String(response.status)}.`,
        );
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw invalidContract("JSON response");
      }
      return parseBaseProduct(payload, sourceUrl, specification);
}

async function parsePaidOrderResponse(response: Response, expectedId: string) {
  if (response.status === 401 || response.status === 403) {
    throw new ShopifyAdminAuthenticationError(
      "Shopify rejected the configured Admin token.",
    );
  }
  if (response.status === 429) {
    throw new ShopifyAdminRateLimitError(
      "Shopify rate limited the order request.",
    );
  }
  if (!response.ok) {
    throw new ShopifyAdminDependencyError(
      `Shopify Admin request failed with status ${String(response.status)}.`,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw invalidContract("paid order JSON response");
  }
  return parsePaidOrder(payload, expectedId);
}

function parsePaidOrder(value: unknown, expectedId: string): ShopifyPaidOrder {
  if (!isRecord(value) || hasGraphqlErrors(value) || !isRecord(value["data"]) ||
      !isRecord(value["data"]["order"])) {
    throw invalidContract("paid order");
  }
  const order = value["data"]["order"];
  const id = gid(order["id"], "Order");
  const name = nonEmptyString(order["name"]);
  const updatedAt = isoDateTime(order["updatedAt"]);
  const cancelledAt = nullableIsoDateTime(order["cancelledAt"]);
  const financialStatus = nonEmptyString(order["displayFinancialStatus"]);
  const email = nonEmptyString(order["email"]);
  if (
    id !== expectedId || !name || !updatedAt ||
    typeof order["edited"] !== "boolean" || !financialStatus || !email
  ) throw invalidContract("paid order");
  const money = parseCurrentTotal(order["currentTotalPriceSet"]);
  const risk = parseRisk(order["risk"]);
  const addressResult = parseAddress(order["shippingAddress"], email);
  const lines = parsePaidOrderLines(order["lineItems"]);
  return {
    address: addressResult.address,
    addressValidationResult: addressResult.validationResult,
    cancelledAt,
    currencyCode: money.currencyCode,
    edited: order["edited"],
    financialStatus,
    fraudResult: risk,
    id,
    lines,
    name,
    totalMinorUnits: money.totalMinorUnits,
    updatedAt,
  };
}

function hasGraphqlErrors(value: Record<string, unknown>) {
  return Array.isArray(value["errors"]) && value["errors"].length > 0;
}

function parseCurrentTotal(value: unknown) {
  if (!isRecord(value) || !isRecord(value["presentmentMoney"])) {
    throw invalidContract("paid order total");
  }
  const amount = nonEmptyString(value["presentmentMoney"]["amount"]);
  const currencyCode = nonEmptyString(
    value["presentmentMoney"]["currencyCode"],
  );
  if (!amount || !currencyCode || !/^[A-Z]{3}$/u.test(currencyCode)) {
    throw invalidContract("paid order total");
  }
  const totalMinorUnits = moneyToMinorUnits(amount, currencyCode);
  if (totalMinorUnits === undefined) throw invalidContract("paid order total");
  return { currencyCode, totalMinorUnits };
}

function parseRisk(value: unknown): ShopifyFraudResult {
  if (!isRecord(value) || !Array.isArray(value["assessments"])) {
    return "pending";
  }
  for (const assessment of value["assessments"]) {
    if (!isRecord(assessment) ||
        !nonEmptyString(assessment["riskLevel"])) {
      throw invalidContract("paid order risk assessment");
    }
    if (assessment["riskLevel"] === "PENDING") return "pending";
  }
  switch (value["recommendation"]) {
    case "ACCEPT": return "accept";
    case "NONE": return "none";
    case "CANCEL": return "cancel";
    case "INVESTIGATE": return "investigate";
    default: throw invalidContract("paid order risk recommendation");
  }
}

function parseAddress(value: unknown, email: string): {
  readonly address: ShopifyDeliveryAddress | null;
  readonly validationResult: ShopifyAddressValidationResult;
} {
  if (value === null) return { address: null, validationResult: "pending" };
  if (!isRecord(value)) throw invalidContract("shipping address");
  const firstName = nonEmptyString(value["firstName"]);
  const lastName = nonEmptyString(value["lastName"]);
  const address1 = nonEmptyString(value["address1"]);
  const city = nonEmptyString(value["city"]);
  const zip = nonEmptyString(value["zip"]);
  const country = nonEmptyString(value["country"]);
  const countryCode = nonEmptyString(value["countryCodeV2"]);
  const validationResult = addressValidationResult(
    value["validationResultSummary"],
  );
  if (!firstName || !lastName || !address1 || !city || !zip || !country ||
      !countryCode || !validationResult) {
    throw invalidContract("shipping address");
  }
  return {
    address: {
      address1,
      address2: nullableString(value["address2"]),
      city,
      company: nullableString(value["company"]),
      country,
      countryCode,
      email,
      firstName,
      lastName,
      phone: nullableString(value["phone"]),
      province: nullableString(value["province"]),
      provinceCode: nullableString(value["provinceCode"]),
      zip,
    },
    validationResult,
  };
}

function addressValidationResult(
  value: unknown,
): ShopifyAddressValidationResult | undefined {
  switch (value) {
    case "NO_ISSUES": return "no_issues";
    case "WARNING": return "warning";
    case "ERROR": return "error";
    case null: return "pending";
    default: return undefined;
  }
}

function nullableString(value: unknown) {
  // Shopify can return an omitted optional address field as an empty string.
  if (value === null || (typeof value === "string" && value.trim() === "")) return null;
  const parsed = nonEmptyString(value);
  if (!parsed) throw invalidContract("shipping address field");
  return parsed;
}

function parsePaidOrderLines(value: unknown): readonly ShopifyPaidOrderLine[] {
  if (!isRecord(value) || !Array.isArray(value["nodes"]) ||
      !isRecord(value["pageInfo"]) ||
      typeof value["pageInfo"]["hasNextPage"] !== "boolean") {
    throw invalidContract("paid order lines");
  }
  if (value["pageInfo"]["hasNextPage"]) {
    throw new ShopifyAdminContractError(
      "The Shopify paid order has more than 250 lines.",
    );
  }
  const lines = value["nodes"].map(parsePaidOrderLine);
  const ids = new Set(lines.map((line) => line.id));
  if (ids.size !== lines.length) throw invalidContract("paid order lines");
  return lines;
}

function parsePaidOrderLine(value: unknown): ShopifyPaidOrderLine {
  if (!isRecord(value) || !isRecord(value["variant"]) ||
      !Array.isArray(value["customAttributes"])) {
    throw invalidContract("paid order line");
  }
  const id = gid(value["id"], "LineItem");
  const shopifyVariantId = gid(value["variant"]["id"], "ProductVariant");
  const currentQuantity = positiveInteger(value["currentQuantity"]);
  const originalQuantity = positiveInteger(value["quantity"]);
  const retailPrice = parseCurrentTotal(value["originalUnitPriceSet"]);
  const lineCapability = singleCustomAttribute(
    value["customAttributes"],
    "_lineCapability",
  );
  if (!id || !shopifyVariantId || !currentQuantity || !originalQuantity ||
      !lineCapability || retailPrice.totalMinorUnits <= 0) {
    throw invalidContract("paid order line");
  }
  return {
    currentQuantity,
    id,
    lineCapability,
    originalQuantity,
    retailCurrencyCode: retailPrice.currencyCode,
    retailPriceMinorUnits: retailPrice.totalMinorUnits,
    shopifyVariantId,
  };
}

function singleCustomAttribute(value: readonly unknown[], key: string) {
  const matches = value.flatMap((attribute) => {
    if (!isRecord(attribute) || attribute["key"] !== key) return [];
    const selected = nonEmptyString(attribute["value"]);
    return selected ? [selected] : [];
  });
  return matches.length === 1 ? matches[0] : undefined;
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

function isoDateTime(value: unknown) {
  const parsed = nonEmptyString(value);
  return parsed && !Number.isNaN(Date.parse(parsed)) ? parsed : undefined;
}

function nullableIsoDateTime(value: unknown) {
  if (value === null) return null;
  const parsed = isoDateTime(value);
  if (!parsed) throw invalidContract("paid order timestamp");
  return parsed;
}

function moneyToMinorUnits(value: string, currencyCode: string) {
  let exponent: number;
  try {
    const resolved = new Intl.NumberFormat("en", {
      currency: currencyCode,
      style: "currency",
    }).resolvedOptions().maximumFractionDigits;
    if (resolved === undefined) return undefined;
    exponent = resolved;
  } catch {
    return undefined;
  }
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/u.exec(value);
  if (!match) return undefined;
  const whole = match[1];
  const fraction = match[2] ?? "";
  if (!whole || fraction.length > exponent) return undefined;
  const minorUnits = Number(`${whole}${fraction.padEnd(exponent, "0")}`);
  return Number.isSafeInteger(minorUnits) ? minorUnits : undefined;
}

function logRequestFailure(operation: string, error: unknown) {
  console.error("bent.shop Shopify Admin request failed", {
    ...safeErrorDetails(error),
    operation,
  });
}

function parseBaseProduct(
  value: unknown,
  sourceUrl: string,
  specification: BaseProductSpecification,
): ShopifyBaseProduct {
  if (!isRecord(value) || (Array.isArray(value["errors"]) &&
      value["errors"].length > 0) || !isRecord(value["data"]) ||
      !isRecord(value["data"]["product"])) {
    throw invalidContract("base product");
  }
  const product = value["data"]["product"];
  const id = gid(product["id"], "Product");
  const handle = nonEmptyString(product["handle"]);
  const title = nonEmptyString(product["title"]);
  if (!id || handle !== specification.shopifyHandle || !title ||
      !isRecord(product["variants"]) ||
      !Array.isArray(product["variants"]["nodes"]) ||
      !isRecord(product["variants"]["pageInfo"]) ||
      typeof product["variants"]["pageInfo"]["hasNextPage"] !== "boolean") {
    throw invalidContract("base product");
  }
  if (product["variants"]["pageInfo"]["hasNextPage"]) {
    throw new ShopifyAdminContractError(
      "The Shopify base product has more than 100 variants.",
    );
  }
  const variants = product["variants"]["nodes"].map(
    (variant) => parseVariant(variant, specification),
  );
  validateUniqueVariants(variants);
  return {
    baseProductId: specification.baseProductId,
    baseProductSlug: specification.slug,
    handle,
    id,
    sourceUrl,
    title,
    variants,
  };
}

function parseVariant(
  value: unknown,
  specification: BaseProductSpecification,
): ShopifyBaseVariant {
  if (!isRecord(value) || !Array.isArray(value["selectedOptions"]) ||
      typeof value["availableForSale"] !== "boolean") {
    throw invalidContract("product variant");
  }
  const id = gid(value["id"], "ProductVariant");
  const title = nonEmptyString(value["title"]);
  const sku = value["sku"] === null ? null : nonEmptyString(value["sku"]);
  const options = value["selectedOptions"].map(parseSelectedOption);
  const colorValue = selectedValue(options, "color") ??
    selectedValue(options, "colour") ?? "";
  const color = launchProductColor(colorValue, specification);
  const size = selectedValue(options, "size") ??
    (specification.singleSize ? "One size" : undefined);
  const expectedOptionCount = specification.singleSize &&
      !selectedValue(options, "size")
    ? 1
    : 2;
  if (!id || !title || (value["sku"] !== null && !sku) || !color || !size ||
      options.length !== expectedOptionCount) {
    throw invalidContract("product variant");
  }
  return {
    availableForSale: value["availableForSale"],
    color,
    id,
    size,
    sku: sku ?? null,
    title,
  };
}

function parseSelectedOption(value: unknown): SelectedOption {
  if (!isRecord(value)) throw invalidContract("selected option");
  const name = nonEmptyString(value["name"]);
  const optionValue = nonEmptyString(value["value"]);
  if (!name || !optionValue) throw invalidContract("selected option");
  return { name, value: optionValue };
}

function selectedValue(options: readonly SelectedOption[], name: string) {
  const matches = options.filter(
    (option) => normalized(option.name) === normalized(name),
  );
  return matches.length === 1 ? matches[0]?.value : undefined;
}

function validateUniqueVariants(variants: readonly ShopifyBaseVariant[]) {
  const ids = new Set<string>();
  const combinations = new Set<string>();
  for (const variant of variants) {
    const combination = `${variant.color}\u0000${variant.size}`;
    if (ids.has(variant.id) || combinations.has(combination)) {
      throw new ShopifyAdminContractError(
        "Shopify returned duplicate base-product variant mappings.",
      );
    }
    ids.add(variant.id);
    combinations.add(combination);
  }
}

function gid(value: unknown, type: string) {
  const id = nonEmptyString(value);
  return id?.startsWith(`gid://shopify/${type}/`) ? id : undefined;
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
  return new ShopifyAdminContractError(
    `Shopify returned an invalid ${resource}.`,
  );
}
