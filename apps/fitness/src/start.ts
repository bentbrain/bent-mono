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
 * Routes that authenticate their own bearer tokens and never use a browser
 * session: the MCP endpoint and the iPhone sync device routes.
 */
export function bearerOnlyPath(pathname: string) {
  return (
    pathname === "/api/mcp" ||
    pathname === "/api/health/devices" ||
    pathname.startsWith("/api/health/devices/")
  );
}
/** Signs in browser sessions, except on routes that take bearer tokens only. */
const sessions = createMiddleware().server((context) => {
  const server = clerk.options.server;
  return bearerOnlyPath(new URL(context.request.url).pathname) || !server
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
