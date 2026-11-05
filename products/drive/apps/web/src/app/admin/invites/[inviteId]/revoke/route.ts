import { randomUUID } from "node:crypto";

import { auth } from "@clerk/nextjs/server";
import { Data, Effect, Either } from "effect";

import { revokeInvite } from "@/lib/db/store";
import { requireAdminIdentity } from "@/lib/identity";
import { inviteIdSchema } from "@/lib/invites";
import { runAppResponse } from "@/lib/runtime";

export const runtime = "nodejs";

class RouteParametersError extends Data.TaggedError("RouteParametersError")<{
  message: string;
}> {}

interface RevokeRouteContext {
  params: Promise<{ inviteId: string }>;
}

export async function POST(request: Request, context: RevokeRouteContext): Promise<Response> {
  await auth.protect();
  const program = Effect.gen(function* () {
    const identityResult = yield* Effect.either(requireAdminIdentity);
    if (Either.isLeft(identityResult)) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const params = yield* Effect.tryPromise({
      try: () => context.params,
      catch: () => new RouteParametersError({ message: "Could not read the invite ID." }),
    });
    const inviteId = inviteIdSchema.safeParse(params.inviteId);
    if (!inviteId.success) {
      return Response.json({ error: "invalid_invite" }, { status: 400 });
    }
    const revoked = yield* revokeInvite(
      inviteId.data,
      randomUUID(),
      identityResult.right.clerkUserId
    );
    if (!revoked) {
      return Response.json({ error: "invite_not_found" }, { status: 404 });
    }
    return Response.redirect(new URL("/admin/invites", request.url), 303);
  }).pipe(Effect.withSpan("admin.invite.revoke"));

  return await runAppResponse("route.admin.invites.revoke", program, {
    "http.request.method": request.method,
  });
}
