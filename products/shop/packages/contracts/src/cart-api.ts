import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "@effect/platform";

import {
  AddProductToCartRequestSchema,
  AddProductToCartResponseSchema,
  CartRejected,
} from "./cart";
import {
  DependencyUnavailable,
  InvalidRequest,
  UnexpectedServerError,
} from "./design";

const CartGroup = HttpApiGroup.make("cart").add(
  HttpApiEndpoint.post("addProduct", "/cart/product")
    .setPayload(AddProductToCartRequestSchema)
    .addSuccess(AddProductToCartResponseSchema)
    .addError(InvalidRequest, { status: 400 })
    .addError(CartRejected, { status: 409 })
    .addError(DependencyUnavailable, { status: 503 })
    .addError(UnexpectedServerError, { status: 500 }),
);

export class ForeverTeeStorefrontApi extends HttpApi.make("foreverTeeStorefrontApi")
  .add(CartGroup)
  .prefix("/api/v1") {}
