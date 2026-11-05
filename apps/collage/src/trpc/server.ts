import "server-only";

import { createHydrationHelpers } from "@trpc/react-query/rsc";
import { headers } from "next/headers";
import { cache } from "react";

import { createCaller, type AppRouter } from "@/server/api/root";
import { createTRPCContext } from "@/server/api/trpc";
import { createQueryClient } from "./query-client";

type CreateContextOptions = {
  headers?: Headers;
};

/**
 * This helper creates the TRPC context.
 * It accepts an optional headers option, which is used if provided.
 * If not, it falls back to generating headers from Next.js.
 */
const createContext = cache(async (opts?: CreateContextOptions) => {
  // use provided headers if supplied; otherwise, derive them from next/headers()
  const heads = opts?.headers ?? new Headers(await headers());
  heads.set("x-trpc-source", "rsc");

  return createTRPCContext({
    headers: heads,
  });
});

const getQueryClient = cache(createQueryClient);
const caller = createCaller(createContext);

export const { trpc: api, HydrateClient } = createHydrationHelpers<AppRouter>(
  caller,
  getQueryClient,
);
