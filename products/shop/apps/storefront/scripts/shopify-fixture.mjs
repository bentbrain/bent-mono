export function catalogue(handle) {
  const tote = handle === "cotton-tote";
  if (!tote && handle !== "bent-shirt")
    throw new Error("Unknown synthetic catalogue");
  const colors = tote ? ["Cream", "Black"] : ["White", "Black"];
  const sizes = tote ? ["One size"] : ["S", "M", "L"];
  const title = tote ? "Cotton Tote" : "bent.shop";
  const variants = colors.flatMap((color, c) =>
    sizes.map((size, s) => ({
      id: `gid://shopify/ProductVariant/${tote ? 200 : 100}${c}${s}`,
      title: `${color} / ${size}`,
      availableForSale: true,
      selectedOptions: [
        { name: "Color", value: color },
        { name: "Size", value: size },
      ],
      price: { amount: tote ? "30.00" : "40.00", currencyCode: "AUD" },
      compareAtPrice: null,
      product: {
        id: `gid://shopify/Product/${tote ? 200 : 100}`,
        handle,
        title,
        requiresSellingPlan: false,
        sellingPlanGroups: { nodes: [] },
      },
      sku: `${handle}-${c}-${s}`,
      image: {
        url: "https://cdn.shopify.com/synthetic.png",
        width: 1500,
        height: 1500,
        altText: title,
      },
      quantityAvailable: 100,
    })),
  );
  return {
    id: `gid://shopify/Product/${tote ? 200 : 100}`,
    handle,
    title,
    vendor: "bent.shop",
    requiresSellingPlan: false,
    encodedVariantExistence: tote ? "v1_0:0,1:0" : "v1_0:0-2,1:0-2",
    encodedVariantAvailability: tote ? "v1_0:0,1:0" : "v1_0:0-2,1:0-2",
    options: [
      {
        name: "Color",
        optionValues: colors.map((name) => ({
          name,
          firstSelectableVariant: variants.find(
            (variant) => variant.selectedOptions[0].value === name,
          ),
          swatch: null,
        })),
      },
      {
        name: "Size",
        optionValues: sizes.map((name) => ({
          name,
          firstSelectableVariant: variants.find(
            (variant) => variant.selectedOptions[1].value === name,
          ),
          swatch: null,
        })),
      },
    ],
    selectedOrFirstAvailableVariant: variants[0],
    variants: { nodes: variants, pageInfo: { hasNextPage: false } },
    priceRange: { minVariantPrice: variants[0].price },
  };
}
export function createShopifyFixture(events) {
  const carts = new Map();
  const products = [catalogue("bent-shirt"), catalogue("cotton-tote")];
  const variants = products.flatMap((p) => p.variants.nodes);
  const amount = (quantity) => ({
    amount: String(quantity),
    currencyCode: "AUD",
  });
  function recalculate(cart) {
    cart.totalQuantity = cart.lines.nodes.reduce(
      (n, line) => n + line.quantity,
      0,
    );
    const total = cart.lines.nodes.reduce(
      (n, line) => n + Number(line.merchandise.price.amount) * line.quantity,
      0,
    );
    cart.cost = {
      subtotalAmount: amount(total),
      totalAmount: amount(total),
      checkoutChargeAmount: amount(total),
    };
    return cart;
  }
  function add(cart, inputs) {
    for (const input of inputs) {
      const variant = variants.find((v) => v.id === input.merchandiseId);
      if (!variant) throw new Error("Unknown fixture variant");
      const existing = cart.lines.nodes.find(
        (l) =>
          l.merchandise.id === variant.id &&
          JSON.stringify(l.attributes) ===
            JSON.stringify(input.attributes ?? []),
      );
      if (existing) {
        existing.quantity += input.quantity;
        continue;
      }
      cart.lines.nodes.push({
        id: `gid://shopify/CartLine/${crypto.randomUUID()}`,
        quantity: input.quantity,
        attributes: input.attributes ?? [],
        merchandise: {
          ...variant,
          product: {
            ...variant.product,
            options: products.find((p) => p.handle === variant.product.handle)
              .options,
            variants: {
              nodes: variants.filter(
                (v) => v.product.handle === variant.product.handle,
              ),
            },
          },
        },
        cost: {
          totalAmount: amount(Number(variant.price.amount) * input.quantity),
          subtotalAmount: amount(Number(variant.price.amount) * input.quantity),
          amountPerQuantity: variant.price,
          compareAtAmountPerQuantity: null,
        },
        sellingPlanAllocation: null,
        parentRelationship: null,
        lineComponents: [],
      });
    }
    return recalculate(cart);
  }
  return {
    carts,
    async fetch(request) {
      const { query, variables = {} } = await request.json();
      events.push({
        operation: "shopify",
        name: /\b(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "anonymous",
      });
      const cart = carts.get(variables.cartId ?? variables.id);
      let data;
      if (query.includes("cartCreate(")) {
        const created = {
          id: `gid://shopify/Cart/${crypto.randomUUID()}?key=synthetic`,
          checkoutUrl: "https://checkout.example.invalid/cart/c/J01",
          totalQuantity: 0,
          note: null,
          attributes: variables.input?.attributes ?? [],
          lines: { nodes: [] },
          discountCodes: [],
          buyerIdentity: { countryCode: "AU" },
          cost: {
            subtotalAmount: amount(0),
            totalAmount: amount(0),
            checkoutChargeAmount: amount(0),
          },
        };
        add(created, variables.input?.lines ?? []);
        carts.set(created.id, created);
        data = { cartCreate: { cart: created, userErrors: [], warnings: [] } };
      } else if (query.includes("cartLinesAdd(")) {
        if (!cart) throw new Error("Missing fixture cart");
        data = {
          cartLinesAdd: {
            cart: add(cart, variables.lines),
            userErrors: [],
            warnings: [],
          },
        };
      } else if (query.includes("cartLinesUpdate(")) {
        if (!cart) throw new Error("Missing fixture cart");
        for (const input of variables.lines) {
          const line = cart.lines.nodes.find((l) => l.id === input.id);
          if (!line) throw new Error("Missing fixture line");
          if (input.quantity !== undefined) line.quantity = input.quantity;
          if (input.attributes) line.attributes = input.attributes;
        }
        cart.lines.nodes = cart.lines.nodes.filter((l) => l.quantity > 0);
        data = {
          cartLinesUpdate: {
            cart: recalculate(cart),
            userErrors: [],
            warnings: [],
          },
        };
      } else if (query.includes("cartAttributesUpdate(")) {
        if (!cart) throw new Error("Missing fixture cart");
        cart.attributes = variables.attributes;
        data = { cartAttributesUpdate: { cart, userErrors: [] } };
      } else if (query.includes("cartLinesRemove(")) {
        if (!cart) throw new Error("Missing fixture cart");
        cart.lines.nodes = cart.lines.nodes.filter(
          (l) => !variables.lineIds.includes(l.id),
        );
        data = {
          cartLinesRemove: {
            cart: recalculate(cart),
            userErrors: [],
            warnings: [],
          },
        };
      } else if (query.includes("ForeverTeeProduct")) {
        data = { product: catalogue(variables.handle) };
      } else if (
        query.includes("merchandiseId") ||
        query.includes("ForeverTeeCartVariant")
      ) {
        const variant = variants.find((v) => v.id === variables.merchandiseId);
        data = {
          merchandise: variant
            ? {
                __typename: "ProductVariant",
                ...variant,
                sellingPlanAllocations: { nodes: [] },
              }
            : null,
          baseProduct: products.find((p) => p.handle === variables.baseHandle),
        };
      } else if (query.includes("cart(")) {
        data = { cart: cart ?? null };
      } else throw new Error("Unsupported synthetic Shopify operation");
      return Response.json(
        { data },
        { headers: { "x-shopify-request-id": crypto.randomUUID() } },
      );
    },
  };
}
