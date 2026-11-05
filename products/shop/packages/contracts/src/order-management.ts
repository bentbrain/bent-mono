import { Schema } from "effect";

const requiredText = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100), Schema.pattern(/^[^\u0000-\u001f\u007f]+$/u));
const optionalText = Schema.String.pipe(Schema.maxLength(100), Schema.pattern(/^[^\u0000-\u001f\u007f]*$/u));
export const OrderDeliveryAddress = Schema.Struct({
  firstName: requiredText,
  lastName: requiredText,
  address1: requiredText,
  address2: optionalText,
  city: requiredText,
  provinceCode: Schema.Literal("ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"),
  zip: Schema.String.pipe(Schema.pattern(/^\d{4}$/u)),
  countryCode: Schema.Literal("AU"),
  phone: Schema.String.pipe(Schema.maxLength(30), Schema.pattern(/^[+\d ()-]*$/u)),
});
export type OrderDeliveryAddress = typeof OrderDeliveryAddress.Type;
export const OrderManagementCommand = Schema.Union(
  Schema.Struct({ commandId: Schema.UUID, operation: Schema.Literal("address"), address: OrderDeliveryAddress }),
  Schema.Struct({ commandId: Schema.UUID, operation: Schema.Literal("cancel"), confirmation: Schema.Literal("CANCEL AND REFUND") }),
);
export type OrderManagementCommand = typeof OrderManagementCommand.Type;
export const ManagedOrder = Schema.Struct({
  orderName: Schema.String,
  deadline: Schema.String,
  serverTime: Schema.String,
  totalMinorUnits: Schema.Int,
  currencyCode: Schema.Literal("AUD"),
  address: Schema.NullOr(OrderDeliveryAddress),
  addressValidation: Schema.Literal("pending", "no_issues", "warning", "error"),
});
export type ManagedOrder = typeof ManagedOrder.Type;
export const OrderManagementReceipt = Schema.Struct({
  commandId: Schema.String,
  status: Schema.Literal("pending", "processing", "succeeded", "rejected", "ambiguous"),
});
export type OrderManagementReceipt = typeof OrderManagementReceipt.Type;
