import "server-only";

import { env } from "@/env";
import { ConvexHttpClient } from "convex/browser";

function convexUrl(): string {
  if (!env.NEXT_PUBLIC_CONVEX_URL) {
    throw new Error(
      "NEXT_PUBLIC_CONVEX_URL is required when Convex is enabled",
    );
  }
  return env.NEXT_PUBLIC_CONVEX_URL;
}

export function publicConvexClient(): ConvexHttpClient {
  return new ConvexHttpClient(convexUrl());
}

export async function authenticatedConvexClient(
  getToken: () => Promise<string | null>,
): Promise<ConvexHttpClient> {
  const token = await getToken();
  if (!token) {
    throw new Error(
      "Clerk did not issue a Convex token; configure the Clerk 'convex' JWT template",
    );
  }
  const client = publicConvexClient();
  client.setAuth(token);
  return client;
}
