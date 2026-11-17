import { clerkMiddleware } from "@clerk/tanstack-react-start/server";
import {
  createMiddleware,
  createCsrfMiddleware,
  createStart,
} from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
const privateHeaders = createMiddleware().server(async ({ next }) => {
  setResponseHeader("Cache-Control", "private, no-store");
  setResponseHeader("X-Content-Type-Options", "nosniff");
  return next();
});
export const startInstance = createStart(() => ({
  requestMiddleware: [
    privateHeaders,
    createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" }),
    ...(process.env.CLERK_SECRET_KEY && process.env.VITE_CLERK_PUBLISHABLE_KEY
      ? [clerkMiddleware()]
      : []),
  ],
}));
