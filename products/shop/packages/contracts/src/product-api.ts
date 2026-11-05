import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";

import {
  DependencyUnavailable,
  DesignNotFound,
  InvalidRequest,
  UnexpectedServerError,
} from "./design";
import {
  CreateConfiguredProductRequestSchema,
  ProductFamilySchema,
  ProductId,
  ProductNotFound,
  ProductSchema,
} from "./product";

const ProductPath = Schema.Struct({ id: ProductId });

export const ProductsGroup = HttpApiGroup.make("products")
  .add(
    HttpApiEndpoint.get("getProductFamily", "/products/:id/family")
      .setPath(ProductPath)
      .addSuccess(ProductFamilySchema),
  )
  .add(
    HttpApiEndpoint.get("getProduct", "/products/:id")
      .setPath(ProductPath)
      .addSuccess(ProductSchema),
  )
  .add(
    HttpApiEndpoint.post("createConfiguredProduct", "/products")
      .setPayload(CreateConfiguredProductRequestSchema)
      .addSuccess(ProductSchema, { status: 201 }),
  )
  .addError(InvalidRequest, { status: 400 })
  .addError(DesignNotFound, { status: 404 })
  .addError(ProductNotFound, { status: 404 })
  .addError(DependencyUnavailable, { status: 503 })
  .addError(UnexpectedServerError, { status: 500 });
