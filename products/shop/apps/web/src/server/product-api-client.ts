import "server-only";

import {
  DependencyUnavailable,
  ProductFamilySchema,
  ProductId,
  ProductNotFound,
  ProductSchema,
} from "@forever-tee/contracts";
import { Effect, Schema } from "effect";
import { fetch } from "undici";

import { env } from "@/env";

export const getProductFromApi = (id: string) =>
  Effect.uninterruptible(Effect.gen(function*() {
    if (!Schema.is(ProductId)(id)) {
      return yield* Effect.fail(new ProductNotFound({ message: "Product not found." }));
    }
    const response = yield* Effect.tryPromise({
      try: () => fetch(apiUrl(`/v1/products/${encodeURIComponent(id)}`)),
      catch: () => unavailable(),
    });
    if (response.status === 404) {
      return yield* Effect.fail(
        new ProductNotFound({ message: "Product not found." }),
      );
    }
    if (!response.ok) return yield* Effect.fail(unavailable());

    const payload = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => unavailable(),
    });
    return yield* Schema.decodeUnknown(ProductSchema)(payload).pipe(
      Effect.mapError(() => unavailable()),
    );
  }));

export const getProductFamilyFromApi = (id: string) =>
  Effect.uninterruptible(Effect.gen(function*() {
    if (!Schema.is(ProductId)(id)) {
      return yield* Effect.fail(new ProductNotFound({ message: "Product not found." }));
    }
    const response = yield* Effect.tryPromise({
      try: () => fetch(apiUrl(`/v1/products/${encodeURIComponent(id)}/family`)),
      catch: () => unavailable(),
    });
    if (response.status === 404) {
      return yield* Effect.fail(
        new ProductNotFound({ message: "Product not found." }),
      );
    }
    if (!response.ok) return yield* Effect.fail(unavailable());

    const payload = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => unavailable(),
    });
    return yield* Schema.decodeUnknown(ProductFamilySchema)(payload).pipe(
      Effect.mapError(() => unavailable()),
    );
  }));

function apiUrl(path: string) {
  return new URL(path, `${env.FOREVER_TEE_API_URL.replace(/\/$/, "")}/`);
}

function unavailable() {
  return new DependencyUnavailable({
    message: "Product storage is unavailable.",
  });
}
