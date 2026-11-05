import "server-only";

import { env } from "@/env";
import { createClerkClient } from "@clerk/backend";

let clerkBackendClient: ReturnType<typeof createClerkClient> | undefined;

/** Header-free Clerk client for shared cache scopes and background work. */
export function getClerkBackendClient() {
  clerkBackendClient ??= createClerkClient({
    secretKey: env.CLERK_SECRET_KEY,
  });

  return clerkBackendClient;
}
