import { Effect, Either, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  PrintifyCreateOrderRequestSchema,
  PrintifyCreateProductRequestSchema,
  PrintifyProductionClient,
  PrintifyUploadByUrlRequestSchema,
  makePrintifyProductionClientLayer,
} from "./printify-production-client";

const ENV = {
  PRINTIFY_API_TOKEN: "printify-test-token",
  PRINTIFY_SHOP_ID: "12345",
};

const IMAGE = {
  file_name: "bent-asset.png",
  height: 5_100,
  id: "image-123",
  mime_type: "image/png",
  preview_url: "https://images.example.test/image-123",
  size: 15_000,
  upload_time: "2026-08-30 10:00:00",
  width: 4_500,
};

const PRODUCT = {
  blueprint_id: 440,
  description: "Internal fulfilment product.",
  id: "product-123",
  is_locked: false,
  print_areas: [{
    placeholders: [{
      decoration_method: "dtg",
      images: [{
        angle: 0,
        height: 5_100,
        id: IMAGE.id,
        scale: 1,
        type: "image/png",
        width: 4_500,
        x: 0.5,
        y: 0.5,
      }],
      position: "front",
    }],
    variant_ids: [123],
  }],
  print_provider_id: 34,
  shop_id: 12_345,
  title: "Bent internal product",
  variants: [{
    cost: 3_180,
    id: 123,
    is_available: true,
    is_enabled: true,
    price: 7_000,
    sku: "bnt-product-123",
  }],
  visible: true,
};

const UPLOAD_REQUEST = Schema.decodeUnknownSync(
  PrintifyUploadByUrlRequestSchema,
)({
  file_name: IMAGE.file_name,
  url: "https://api.example.test/v2/print-assets/asset/download?grant=token",
});

const PRODUCT_REQUEST = Schema.decodeUnknownSync(
  PrintifyCreateProductRequestSchema,
)({
  blueprint_id: 440,
  description: PRODUCT.description,
  print_areas: [{
    placeholders: [{
      images: [{ angle: 0, id: IMAGE.id, scale: 1, x: 0.5, y: 0.5 }],
      position: "front",
    }],
    variant_ids: [123],
  }],
  print_provider_id: 34,
  title: PRODUCT.title,
  variants: [{
    id: 123,
    is_enabled: true,
    price: 7_000,
    sku: "bnt-product-123",
  }],
});

const ORDER_REQUEST = Schema.decodeUnknownSync(
  PrintifyCreateOrderRequestSchema,
)({
  address_to: {
    address1: "1 Queen Street",
    city: "Brisbane",
    country: "AU",
    email: "buyer@example.com",
    first_name: "Ada",
    last_name: "Lovelace",
    region: "QLD",
    zip: "4000",
  },
  external_id: "order-123",
  label: "#1001",
  line_items: [{
    external_id: "line-123",
    product_id: PRODUCT.id,
    quantity: 2,
    variant_id: 123,
  }],
  send_shipping_notification: false,
  shipping_method: 1,
});

const ORDER = {
  address_to: {
    ...ORDER_REQUEST.address_to,
    address2: "",
    country: "Australia",
    region: "Queensland",
  },
  id: "printify-order-123",
  line_items: [{
    cost: 3_180,
    external_id: "line-123",
    metadata: {
      external_id: "line-123",
      price: 7_000,
      sku: "bnt-product-123",
    },
    print_provider_id: 34,
    product_id: PRODUCT.id,
    quantity: 2,
    shipping_cost: 1_084,
    status: "on-hold",
    variant_id: 123,
  }],
  sent_to_production_at: null,
  shipments: [],
  shipping_method: 1,
  status: "on-hold",
};

describe("Printify production client", () => {
  it("uploads by URL and decodes the provider response", async () => {
    const requests: Request[] = [];
    const fetcher: typeof fetch = (input, init) => {
      requests.push(new Request(input, init));
      return Promise.resolve(Response.json(IMAGE));
    };

    const image = await runClient(fetcher, (client) =>
      client.uploadImageByUrl(UPLOAD_REQUEST)
    );

    expect(image).toEqual(IMAGE);
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("https://api.printify.com/v1/uploads/images.json");
    expect(request?.headers.get("authorization")).toBe(
      "Bearer printify-test-token",
    );
    expect(await request?.json()).toEqual(UPLOAD_REQUEST);
  });

  it("creates a shop-scoped product and decodes its exact identity", async () => {
    const requests: Request[] = [];
    const fetcher: typeof fetch = (input, init) => {
      requests.push(new Request(input, init));
      return Promise.resolve(Response.json(PRODUCT));
    };

    const product = await runClient(fetcher, (client) =>
      client.createProduct(PRODUCT_REQUEST)
    );

    expect(product.id).toBe("product-123");
    expect(requests[0]?.url).toBe(
      "https://api.printify.com/v1/shops/12345/products.json",
    );
    expect(await requests[0]?.json()).toEqual(PRODUCT_REQUEST);
  });

  it("reads disabled catalogue variants with empty SKUs", async () => {
    const selected = PRODUCT.variants[0];
    if (!selected) throw new Error("Missing selected fixture");
    const response = { ...PRODUCT, variants: [selected, { ...selected, id: 124, is_enabled: false, sku: "" }] };
    const fetcher: typeof fetch = () => Promise.resolve(Response.json(response));
    expect(await runClient(fetcher, client => client.getProduct(PRODUCT.id))).toEqual(response);
  });

  it("rejects an enabled variant with an empty SKU", async () => {
    const response = { ...PRODUCT, variants: PRODUCT.variants.map(variant => ({ ...variant, sku: "" })) };
    const fetcher: typeof fetch = () => Promise.resolve(Response.json(response));
    const result = await runClient(fetcher, client => Effect.either(client.getProduct(PRODUCT.id)));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left._tag).toBe("PrintifyProductionContractError");
  });

  it("creates, reads, and submits a typed shop-scoped order", async () => {
    const requests: Request[] = [];
    const fetcher: typeof fetch = (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.endsWith("/send_to_production.json")) {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      return Promise.resolve(Response.json(ORDER));
    };

    const order = await runClient(fetcher, (client) =>
      Effect.gen(function*() {
        const created = yield* client.createOrder(ORDER_REQUEST);
        const read = yield* client.getOrder(created.id);
        yield* client.sendOrderToProduction(read.id);
        return read;
      })
    );

    expect(order).toEqual(ORDER);
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "POST https://api.printify.com/v1/shops/12345/orders.json",
      "GET https://api.printify.com/v1/shops/12345/orders/printify-order-123.json",
      "POST https://api.printify.com/v1/shops/12345/orders/printify-order-123/send_to_production.json",
    ]);
    expect(await requests[0]?.json()).toEqual(ORDER_REQUEST);
  });

  it("rejects a malformed success response in the typed error channel", async () => {
    const result = await runClientEither(
      () => Promise.resolve(Response.json({ id: "image-123" })),
      (client) => client.uploadImageByUrl(UPLOAD_REQUEST),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("PrintifyProductionContractError");
    }
  });

  it.each([{}, { id: "" }])("keeps an unreadable product create success ambiguous", async body => {
    const result = await runClientEither(() => Promise.resolve(Response.json(body)), client => client.createProduct(PRODUCT_REQUEST));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left._tag).toBe("PrintifyAmbiguousMutationError");
  });

  it.each([{}, { id: "" }])("keeps an unreadable order create success ambiguous", async body => {
    const result = await runClientEither(() => Promise.resolve(Response.json(body)), client => client.createOrder(ORDER_REQUEST));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left._tag).toBe("PrintifyAmbiguousMutationError");
  });

  it("marks a lost mutation response as ambiguous instead of retryable", async () => {
    const result = await runClientEither(
      () => Promise.reject(new Error("connection reset")),
      (client) => client.createProduct(PRODUCT_REQUEST),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("PrintifyAmbiguousMutationError");
    }
  });

  it("keeps a failed read non-ambiguous", async () => {
    const result = await runClientEither(
      () => Promise.reject(new Error("connection reset")),
      (client) => client.getUploadedImage(IMAGE.id),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("PrintifyProductionDependencyError");
      if (result.left._tag === "PrintifyProductionDependencyError") {
        expect(result.left.status).toBeUndefined();
      }
    }
  });

  it("does not treat rate limiting as an ambiguous mutation", async () => {
    const result = await runClientEither(
      () => Promise.resolve(new Response(null, {
        headers: { "retry-after": "17" },
        status: 429,
      })),
      (client) => client.uploadImageByUrl(UPLOAD_REQUEST),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("PrintifyProductionRateLimitError");
      if (result.left._tag === "PrintifyProductionRateLimitError") {
        expect(result.left.retryAfterSeconds).toBe(17);
      }
    }
  });
});

function runClient<Success>(
  fetcher: typeof fetch,
  operation: (
    client: Effect.Effect.Success<typeof PrintifyProductionClient>,
  ) => Effect.Effect<Success, unknown>,
) {
  return Effect.runPromise(
    Effect.gen(function*() {
      const client = yield* PrintifyProductionClient;
      return yield* operation(client);
    }).pipe(Effect.provide(makePrintifyProductionClientLayer(ENV, fetcher))),
  );
}

function runClientEither<Success, Failure>(
  fetcher: typeof fetch,
  operation: (
    client: Effect.Effect.Success<typeof PrintifyProductionClient>,
  ) => Effect.Effect<Success, Failure>,
) {
  return Effect.runPromise(
    Effect.gen(function*() {
      const client = yield* PrintifyProductionClient;
      return yield* operation(client);
    }).pipe(
      Effect.provide(makePrintifyProductionClientLayer(ENV, fetcher)),
      Effect.either,
    ),
  );
}
