import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse, type NextMiddleware } from "next/server";

const isPublicRoute = createRouteMatcher([
  "/",
  "/user_([^/]+)",
  "/sign-in(.*)",
  "/api/uploadthing(.*)",
  "/api/trpc/collage.getAllPublic(.*)",
  "/api/media(.*)",
  "/privacy-policy",
]);

const authenticate = clerkMiddleware(
  async (auth, request) => {
    if (!isPublicRoute(request)) {
      const authState = await auth();

      if (!authState.userId) {
        const isApiRequest =
          request.nextUrl.pathname.startsWith("/api/") ||
          request.nextUrl.pathname.startsWith("/trpc/");

        if (isApiRequest) {
          await auth.protect();
          return;
        }

        return authState.redirectToSignIn({
          returnBackUrl: request.url,
        });
      }
    }
  },
  {
    // Use the registered Clerk frontend domain for session handshakes.
    // A production Frontend API proxy requires separate Clerk domain registration.
    frontendApiProxy: { enabled: false },
  },
);

const proxy: NextMiddleware = (request, event) => {
  // Clerk may initiate a handshake before its auth callback runs.
  if (request.nextUrl.hostname === "maya-collage.vercel.app") {
    const canonicalUrl = request.nextUrl.clone();
    canonicalUrl.hostname = "maya-collage.bent.build";
    return NextResponse.redirect(canonicalUrl);
  }

  return authenticate(request, event);
};

export default proxy;

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
