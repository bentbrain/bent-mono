import { randomUUID } from "node:crypto";

import { auth } from "@clerk/nextjs/server";
import { Effect, Either } from "effect";

import { hashToken } from "@/lib/crypto";
import { createInvite } from "@/lib/db/store";
import { requireAdminIdentity } from "@/lib/identity";
import { createInviteInputSchema } from "@/lib/invites";
import { runAppResponse } from "@/lib/runtime";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  await auth.protect();
  const program = Effect.gen(function* () {
    const identityResult = yield* Effect.either(requireAdminIdentity);
    if (Either.isLeft(identityResult)) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const formData = yield* Effect.tryPromise({
      try: () => request.formData(),
      catch: () => new Error("The invite form could not be read."),
    });
    const parsed = createInviteInputSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) {
      return Response.json(
        { error: "invalid_invite", issues: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }
    const nowEpoch = Math.floor(Date.now() / 1_000);
    const expiresAtEpoch = nowEpoch + parsed.data.expiresInDays * 24 * 60 * 60;
    const githubUsernameFingerprint = hashToken(parsed.data.githubUsername).slice(0, 16);
    yield* createInvite(
      randomUUID(),
      parsed.data.githubUsername,
      expiresAtEpoch,
      randomUUID(),
      identityResult.right.clerkUserId,
      githubUsernameFingerprint
    );
    return Response.redirect(new URL("/admin/invites", request.url), 303);
  }).pipe(Effect.withSpan("admin.invite.create"));

  return await runAppResponse("route.admin.invites.create", program, {
    "http.request.method": request.method,
  });
}
