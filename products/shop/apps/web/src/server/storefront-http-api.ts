import "server-only";

import {
  HttpApiBuilder,
  HttpServer,
  HttpServerResponse,
} from "@effect/platform";
import { ForeverTeeStorefrontApi } from "@forever-tee/contracts";
import { Effect, Layer } from "effect";

import { addProductLine } from "@/server/cart-program";

const CartHandlers = HttpApiBuilder.group(
  ForeverTeeStorefrontApi,
  "cart",
  (handlers) =>
    handlers.handle("addProduct", ({ payload, request }) => {
      const protocol = request.headers["x-forwarded-proto"] ?? "http";
      const host = request.headers["host"] ?? "localhost:3000";
      const webRequest = new Request(
        new URL(request.originalUrl, `${protocol}://${host}`),
        {
          method: request.method,
          headers: Object.entries(request.headers),
        },
      );
      return addProductLine(webRequest, payload).pipe(
        Effect.map(({ cartId, setCookie }) =>
          HttpServerResponse.unsafeJson(
            { cartId },
            { headers: { "set-cookie": setCookie } },
          ),
        ),
      );
    }),
);

const { handler } = HttpApiBuilder.toWebHandler(
  Layer.merge(
    HttpApiBuilder.api(ForeverTeeStorefrontApi).pipe(
      Layer.provide(CartHandlers),
    ),
    HttpServer.layerContext,
  ),
);

export { handler as storefrontApiHandler };
