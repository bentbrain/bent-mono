import { Schema } from "effect";

export const ProductAvailabilitySchema = Schema.Struct({
  available: Schema.Boolean,
});

export type ProductAvailability = Schema.Schema.Type<
  typeof ProductAvailabilitySchema
>;
