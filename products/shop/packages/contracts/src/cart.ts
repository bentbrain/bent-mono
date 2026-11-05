import { Schema } from "effect";

import { ProductId } from "./product";
import { DesignId } from "./design";

export const CartProductContextSchema = Schema.Struct({
  productId: ProductId,
  designId: DesignId,
  baseShopifyHandle: Schema.String.pipe(Schema.minLength(1)),
});

export const AddProductToCartRequestSchema = Schema.Struct({
  productId: ProductId,
  merchandiseId: Schema.String.pipe(Schema.minLength(1)),
  quantity: Schema.Int.pipe(Schema.between(1, 10)),
});

export type AddProductToCartRequest = Schema.Schema.Type<
  typeof AddProductToCartRequestSchema
>;

export const AddProductToCartResponseSchema = Schema.Struct({
  cartId: Schema.String.pipe(Schema.minLength(1)),
});

export class CartRejected extends Schema.TaggedError<CartRejected>()(
  "CartRejected",
  { message: Schema.String },
) {}
