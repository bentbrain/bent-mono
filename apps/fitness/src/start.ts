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
const clerk = clerkMiddleware();
/**
 * Signs in browser sessions. The MCP endpoint authenticates its own bearer
 * tokens against its audience, so it skips the session check.
 */
const sessions = createMiddleware().server((context) => {
  const server = clerk.options.server;
  return new URL(context.request.url).pathname === "/api/mcp" || !server
    ? context.next()
    : server(context);
});
export const startInstance = createStart(() => ({
  requestMiddleware: [
    privateHeaders,
    createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" }),
    ...(process.env.CLERK_SECRET_KEY && process.env.VITE_CLERK_PUBLISHABLE_KEY
      ? [sessions]
      : []),
  ],
}));
