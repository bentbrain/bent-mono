import "server-only";

import { cookies } from "next/headers";

import {
  ANONYMOUS_SESSION_COOKIE,
  anonymousOwnerId,
  anonymousSessionCookieOptions,
  createAnonymousSessionToken,
} from "@/server/anonymous-session-core";

export async function anonymousOwner() {
  const cookieStore = await cookies();
  const existing = cookieStore.get(ANONYMOUS_SESSION_COOKIE)?.value;
  const token = existing && /^[A-Za-z0-9_-]{43}$/.test(existing)
    ? existing
    : createAnonymousSessionToken();
  if (token !== existing) {
    cookieStore.set(ANONYMOUS_SESSION_COOKIE, token, {
      ...anonymousSessionCookieOptions,
    });
  }
  return { ownerId: await anonymousOwnerId(token), created: token !== existing };
}
