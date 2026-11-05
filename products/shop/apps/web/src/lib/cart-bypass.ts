const UNSAFE_METHODS = new Set(["DELETE", "PATCH", "POST", "PUT"]);
const CART_MUTATION_PATH = /^\/cart(?:\/(?:add|change|clear|update)(?:\.js)?|\.js)$/;
const CART_PERMALINK_PATH = /^\/cart\/.+/;
const STOREFRONT_GRAPHQL_PATH = /^\/api(?:\/\d{4}-\d{2})?\/graphql\.json$/;

export interface CartBypassRejection {
  readonly code: "cart_boundary_required";
  readonly message: string;
}

export async function cartBypassRejection(
  request: Pick<Request, "clone" | "method" | "url">,
): Promise<CartBypassRejection | undefined> {
  const pathname = new URL(request.url).pathname;
  if (UNSAFE_METHODS.has(request.method) && CART_MUTATION_PATH.test(pathname)) {
    return rejection("Direct browser cart mutations are disabled.");
  }
  if (CART_PERMALINK_PATH.test(pathname)) {
    return rejection("Cart permalinks are disabled. Use the bent.shop cart.");
  }
  if (
    request.method === "POST" &&
    STOREFRONT_GRAPHQL_PATH.test(pathname) &&
    await containsGraphqlMutation(request.clone())
  ) {
    return rejection("Browser Storefront API mutations are disabled.");
  }
  return undefined;
}

async function containsGraphqlMutation(request: Pick<Request, "text">) {
  const body = await request.text();
  try {
    const parsed: unknown = JSON.parse(body);
    return graphqlQueries(parsed).some((query) => /\bmutation\b/.test(query));
  } catch {
    return /\bmutation\b/.test(body);
  }
}

function graphqlQueries(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(graphqlQueries);
  if (!isRecord(value)) return [];
  const query = value["query"];
  return typeof query === "string" ? [query] : [];
}

function rejection(message: string): CartBypassRejection {
  return { code: "cart_boundary_required", message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
