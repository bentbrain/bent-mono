import "server-only";

import { env } from "@/env";
import { TRPCError } from "@trpc/server";

export function requireMigrationWritesEnabled(): void {
  if (!env.MIGRATION_MAINTENANCE_MODE) return;

  throw new TRPCError({
    code: "SERVICE_UNAVAILABLE",
    message:
      "Saving is temporarily paused while we safely migrate your data. Please try again in a few minutes.",
  });
}
