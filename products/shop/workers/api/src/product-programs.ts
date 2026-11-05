import { Effect } from "effect";

import { DesignRepository } from "./design-repository";
import { ProductRepository } from "./product-repository";

export const getProduct = (id: string) =>
  Effect.gen(function*() {
    const repository = yield* ProductRepository;
    return yield* repository.find(id);
  }).pipe(Effect.withSpan("product.get", { attributes: { id } }));

export const getProductFamily = (id: string) =>
  Effect.gen(function*() {
    const repository = yield* ProductRepository;
    return yield* repository.findFamily(id);
  }).pipe(Effect.withSpan("product.getFamily", { attributes: { id } }));

export const createConfiguredProduct = (
  baseProductId: string,
  designId: string,
) =>
  Effect.gen(function*() {
    const designs = yield* DesignRepository;
    yield* designs.find(designId);
    const products = yield* ProductRepository;
    return yield* products.createConfigured({ baseProductId, designId });
  }).pipe(
    Effect.withSpan("product.createConfigured", {
      attributes: { baseProductId, designId },
    }),
  );
