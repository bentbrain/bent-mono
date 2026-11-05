import "server-only";
import { CartProductContextSchema, CartRejected, DependencyUnavailable } from "@forever-tee/contracts";
import { Effect, Schema } from "effect";
import { fetch } from "undici";
import { env } from "@/env";

const FailureSchema = Schema.Struct({ error: Schema.Struct({
  code: Schema.Literal("CartRejected", "DependencyUnavailable"),
  message: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(500)),
}) });
const unavailable = () => new DependencyUnavailable({ message: "Product storage is unavailable." });

export const getCartProductContext = (productId: string) => Effect.gen(function*() {
  const response = yield* Effect.tryPromise({
    try: () => fetch(new URL(`/v2/internal/cart-product-context/${encodeURIComponent(productId)}`, env.FOREVER_TEE_API_URL), {
      headers: { "x-forever-tee-service-secret": env.FOREVER_TEE_API_SHARED_SECRET },
      redirect: "error", signal: AbortSignal.timeout(5_000),
    }), catch: unavailable,
  });
  const payload = yield* Effect.tryPromise({ try: () => response.json(), catch: unavailable });
  if (response.status === 409 || response.status === 503) {
    const failure = yield* Schema.decodeUnknown(FailureSchema)(payload).pipe(Effect.mapError(unavailable));
    if (response.status === 409 && failure.error.code === "CartRejected") {
      return yield* Effect.fail(new CartRejected({ message: failure.error.message }));
    }
    if (response.status === 503 && failure.error.code === "DependencyUnavailable") {
      return yield* Effect.fail(new DependencyUnavailable({ message: failure.error.message }));
    }
    return yield* Effect.fail(unavailable());
  }
  if (!response.ok) return yield* Effect.fail(unavailable());
  const context = yield* Schema.decodeUnknown(CartProductContextSchema)(payload).pipe(Effect.mapError(unavailable));
  if (context.productId !== productId) return yield* Effect.fail(unavailable());
  return context;
});
