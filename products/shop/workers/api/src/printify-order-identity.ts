import { Schema } from "effect";

const NonEmptyText = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(512));
const ProviderId = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128));
const PositiveInt = Schema.Int.pipe(Schema.positive());
const NonNegativeInt = Schema.Int.pipe(Schema.nonNegative());
const IsoDateTime = Schema.String.pipe(
  Schema.filter((value) => !Number.isNaN(Date.parse(value))),
);
const HttpUrl = Schema.String.pipe(
  Schema.filter((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  }),
);

const PrintifyOrderResponseAddressSchema = Schema.Struct({
  address1: NonEmptyText,
  address2: Schema.optionalWith(Schema.String.pipe(Schema.maxLength(512)), { nullable: true }),
  city: NonEmptyText,
  company: Schema.optionalWith(Schema.String.pipe(Schema.maxLength(512)), { nullable: true }),
  country: NonEmptyText,
  email: NonEmptyText,
  first_name: NonEmptyText,
  last_name: NonEmptyText,
  phone: Schema.optionalWith(Schema.String.pipe(Schema.maxLength(512)), { nullable: true }),
  region: Schema.optionalWith(Schema.String.pipe(Schema.maxLength(512)), { nullable: true }),
  zip: NonEmptyText,
});

const PrintifyOrderLineMetadataSchema = Schema.Struct({
  external_id: Schema.optional(NonEmptyText),
  price: PositiveInt,
  sku: NonEmptyText,
});

const PrintifyOrderLineSchema = Schema.Struct({
  cost: NonNegativeInt,
  external_id: Schema.optional(NonEmptyText),
  metadata: PrintifyOrderLineMetadataSchema,
  print_provider_id: PositiveInt,
  product_id: ProviderId,
  quantity: PositiveInt,
  shipping_cost: NonNegativeInt,
  status: NonEmptyText,
  variant_id: PositiveInt,
});

const PrintifyOrderShipmentSchema = Schema.Struct({
  carrier: NonEmptyText,
  delivered_at: Schema.NullOr(IsoDateTime),
  number: NonEmptyText,
  url: HttpUrl,
});

export const PrintifyOrderSchema = Schema.Struct({
  address_to: PrintifyOrderResponseAddressSchema,
  id: ProviderId,
  line_items: Schema.Array(PrintifyOrderLineSchema).pipe(Schema.minItems(1)),
  sent_to_production_at: Schema.optionalWith(Schema.NullOr(IsoDateTime), { default: () => null }),
  shipments: Schema.optionalWith(Schema.Array(PrintifyOrderShipmentSchema), { default: () => [] }),
  shipping_method: PositiveInt,
  status: NonEmptyText,
});

export type PrintifyOrder = Schema.Schema.Type<typeof PrintifyOrderSchema>;

const PrintifyOrderAddressSchema = Schema.Struct({
  address1: NonEmptyText,
  address2: Schema.optional(NonEmptyText),
  city: NonEmptyText,
  company: Schema.optional(NonEmptyText),
  country: Schema.String.pipe(Schema.pattern(/^[A-Z]{2}$/u)),
  email: NonEmptyText,
  first_name: NonEmptyText,
  last_name: NonEmptyText,
  phone: Schema.optional(NonEmptyText),
  region: Schema.optional(NonEmptyText),
  zip: NonEmptyText,
});

const PrintifyCreateOrderLineSchema = Schema.Struct({
  external_id: NonEmptyText,
  product_id: ProviderId,
  quantity: PositiveInt,
  variant_id: PositiveInt,
});

export const PrintifyCreateOrderRequestSchema = Schema.Struct({
  address_to: PrintifyOrderAddressSchema,
  external_id: NonEmptyText,
  label: NonEmptyText,
  line_items: Schema.Array(PrintifyCreateOrderLineSchema).pipe(
    Schema.minItems(1),
    Schema.maxItems(10),
  ),
  send_shipping_notification: Schema.Literal(false),
  shipping_method: Schema.Literal(1),
});

export type PrintifyCreateOrderRequest = Schema.Schema.Type<
  typeof PrintifyCreateOrderRequestSchema
>;

interface OrderIdentityLine {
  readonly print_provider_id: number;
  readonly external_id: string;
  readonly provider_product_id: string;
  readonly printify_variant_id: number;
  readonly quantity: number;
  readonly retail_price_minor_units: number;
  readonly provider_sku: string;
}

export const DeliveryAddressSchema = Schema.Struct({
  address1: NonEmptyText,
  address2: Schema.NullOr(NonEmptyText),
  city: NonEmptyText,
  company: Schema.NullOr(NonEmptyText),
  country: NonEmptyText,
  countryCode: Schema.String.pipe(Schema.pattern(/^[A-Z]{2}$/u)),
  email: NonEmptyText,
  firstName: NonEmptyText,
  lastName: NonEmptyText,
  phone: Schema.NullOr(NonEmptyText),
  province: Schema.NullOr(NonEmptyText),
  provinceCode: Schema.NullOr(NonEmptyText),
  zip: NonEmptyText,
});

export type DeliveryAddress = Schema.Schema.Type<typeof DeliveryAddressSchema>;

export function orderIdentityMismatchFields(
  providerOrderId: string,
  request: PrintifyCreateOrderRequest,
  address: DeliveryAddress,
  lines: readonly OrderIdentityLine[],
  order: PrintifyOrder,
) {
  const failures: string[] = [];
  const check = (ok: boolean, field: string) => { if (!ok) failures.push(field); };
  check(order.id === providerOrderId, "order.id");
  check(order.shipping_method === 1, "order.shipping_method");
  check(order.status === "on-hold", "order.status");
  check(order.sent_to_production_at === null, "order.sent_to_production_at");
  check(order.shipments.length === 0, "order.shipments");
  check(order.line_items.length === lines.length, "order.line_count");
  const expected = request.address_to;
  const actual = order.address_to;
  const country = actual.country.trim().toLocaleUpperCase("en");
  const region = normalizedOptional(actual.region);
  check(expected.address1 === actual.address1, "address.address1");
  check(normalizedOptional(expected.address2) === normalizedOptional(actual.address2), "address.address2");
  check(expected.city === actual.city, "address.city");
  check(normalizedOptional(expected.company) === normalizedOptional(actual.company), "address.company");
  check(country === address.countryCode.toLocaleUpperCase("en") || country === address.country.trim().toLocaleUpperCase("en"), "address.country");
  check(expected.email.toLocaleLowerCase("en") === actual.email.toLocaleLowerCase("en"), "address.email");
  check(expected.first_name === actual.first_name, "address.first_name");
  check(expected.last_name === actual.last_name, "address.last_name");
  // An omitted optional customer phone is not part of the request identity.
  // Printify can populate it in its response. Supplied phones must still match.
  check(expected.phone === undefined || normalizedPhone(expected.phone) === normalizedPhone(actual.phone), "address.phone");
  check(region === normalizedOptional(address.provinceCode) || region === normalizedOptional(address.province), "address.region");
  check(expected.zip === actual.zip, "address.zip");
  const expectedLines = new Map(lines.map(line => [line.external_id, line]));
  const seen = new Set<string>();
  for (const [index, line] of order.line_items.entries()) {
    const prefix = `line_items.${String(index)}`;
    const externalId = line.external_id ?? line.metadata.external_id;
    if (!externalId || seen.has(externalId)) { failures.push(`${prefix}.external_id`); continue; }
    seen.add(externalId);
    const expectedLine = expectedLines.get(externalId);
    if (!expectedLine) { failures.push(`${prefix}.external_id`); continue; }
    check(expectedLine.provider_product_id === line.product_id, `${prefix}.product_id`);
    check(expectedLine.printify_variant_id === line.variant_id, `${prefix}.variant_id`);
    check(expectedLine.quantity === line.quantity, `${prefix}.quantity`);
    check(line.print_provider_id === expectedLine.print_provider_id, `${prefix}.print_provider_id`);
    check(expectedLine.retail_price_minor_units === line.metadata.price, `${prefix}.metadata.price`);
    check(expectedLine.provider_sku === line.metadata.sku, `${prefix}.metadata.sku`);
    check(line.status === "on-hold", `${prefix}.status`);
  }
  check(seen.size === expectedLines.size, "line_items.external_ids");
  return failures;
}

function normalizedPhone(value: string | null | undefined) {
  const phone = (value ?? "").trim();
  // Printify returns international digits without the request's leading plus.
  // Preserve every digit and reject other differences or missing numbers.
  return /^\+?[1-9][0-9]{1,14}$/u.test(phone) ? phone.replace(/^\+/u, "") : phone;
}

function normalizedOptional(value: string | null | undefined) {
  return (value ?? "").trim().toLocaleUpperCase("en");
}

export function orderReadbackIdentity(order: PrintifyOrder) {
  return {
    addressTo: order.address_to,
    id: order.id,
    lineItems: order.line_items,
    sentToProductionAt: order.sent_to_production_at,
    shippingMethod: order.shipping_method,
    status: order.status,
  };
}

export function orderRequest(
  candidate: { readonly id: string; readonly label: string },
  address: DeliveryAddress,
  lines: readonly OrderIdentityLine[],
): PrintifyCreateOrderRequest {
  const addressTo = {
    address1: address.address1,
    city: address.city,
    country: address.countryCode,
    email: address.email,
    first_name: address.firstName,
    last_name: address.lastName,
    zip: address.zip,
    ...(address.address2 ? { address2: address.address2 } : {}),
    ...(address.company ? { company: address.company } : {}),
    ...(address.phone ? { phone: address.phone } : {}),
    ...(address.provinceCode ? { region: address.provinceCode } : {}),
  };
  return Schema.decodeUnknownSync(PrintifyCreateOrderRequestSchema)({
    address_to: addressTo,
    external_id: candidate.id,
    label: candidate.label,
    line_items: lines.map((line) => ({
      external_id: line.external_id,
      product_id: line.provider_product_id,
      quantity: line.quantity,
      variant_id: line.printify_variant_id,
    })),
    send_shipping_notification: false,
    shipping_method: 1,
  });
}
