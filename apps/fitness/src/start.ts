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
 * session: the MCP endpoint, the Apple Health import and the iPhone sync
 * device routes.
 */
export function bearerOnlyPath(pathname: string) {
  return (
    pathname === "/api/mcp" ||
    pathname === "/api/health/import" ||
    pathname === "/api/health/devices" ||
    pathname.startsWith("/api/health/devices/")
  );
}
/** The path the router matches: trailing slashes are dropped. */
export function routePath(pathname: string) {
  let end = pathname.length;
  while (end > 1 && pathname[end - 1] === "/") end--;
  return pathname.slice(0, end);
}
/** Signs in browser sessions, except on routes that take bearer tokens only. */
const sessions = createMiddleware().server((context) => {
  const server = clerk.options.server;
  return bearerOnlyPath(routePath(new URL(context.request.url).pathname)) ||
    !server
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
