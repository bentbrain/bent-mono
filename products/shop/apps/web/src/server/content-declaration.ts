import "server-only";

import { cookies } from "next/headers";

import { env } from "@/env";
import {
  ANONYMOUS_SESSION_COOKIE,
  anonymousOwnerId,
} from "@/server/anonymous-session-core";
import {
  CONTENT_DECLARATION_COOKIE,
  verifyContentDeclaration,
} from "@/server/content-declaration-core";

export async function hasContentDeclaration() {
  const cookieStore = await cookies();
  const session = cookieStore.get(ANONYMOUS_SESSION_COOKIE)?.value;
  const declaration = cookieStore.get(CONTENT_DECLARATION_COOKIE)?.value;
  if (!session || !declaration || !/^[A-Za-z0-9_-]{43}$/.test(session)) {
    return false;
  }
  return await verifyContentDeclaration(
    declaration,
    await anonymousOwnerId(session),
    env.FOREVER_TEE_API_SHARED_SECRET,
  );
}
