import { clerkClient, currentUser } from "@clerk/nextjs/server";
import { Data, Effect } from "effect";

import { AppConfigService } from "./config";
import { hashToken } from "./crypto";

class ClerkIdentityUnavailableError extends Data.TaggedError(
  "ClerkIdentityUnavailableError"
)<{
  message: string;
}> {}

class GithubIdentityRequiredError extends Data.TaggedError(
  "GithubIdentityRequiredError"
)<{
  message: string;
}> {}

class AdminAccessDeniedError extends Data.TaggedError("AdminAccessDeniedError")<{
  message: string;
}> {}

interface ClerkIdentity {
  clerkUserId: string;
  githubUserId: string;
  githubUsername: string;
  githubUsernameFingerprint: string;
}

interface ExternalAccountIdentity {
  provider: string;
}

export function isGithubAccount(account: ExternalAccountIdentity): boolean {
  return account.provider === "github" || account.provider === "oauth_github";
}

export const getClerkIdentity = (protectedUserId?: string) => Effect.gen(function* () {
  const user = yield* Effect.tryPromise({
    try: async () => {
      if (!protectedUserId) {
        return await currentUser();
      }
      const client = await clerkClient();
      return await client.users.getUser(protectedUserId);
    },
    catch: (cause) =>
      new ClerkIdentityUnavailableError({
        message: cause instanceof Error ? cause.message : "Could not read the Clerk session.",
      }),
  });
  if (!user) {
    return yield* Effect.fail(
      new ClerkIdentityUnavailableError({ message: "Sign in to continue." })
    );
  }
  const githubAccount = user.externalAccounts.find(isGithubAccount);
  const githubUsernameSource = githubAccount?.username ?? user.username;
  if (!githubAccount || !githubUsernameSource) {
    yield* Effect.logWarning("identity.clerk.github_required").pipe(
      Effect.annotateLogs({
        clerkUserId: user.id,
        externalAccountProviders: user.externalAccounts.map((account) => account.provider).join(","),
        hasUserUsername: Boolean(user.username),
      })
    );
    return yield* Effect.fail(
      new GithubIdentityRequiredError({
        message: "A GitHub account with a username is required.",
      })
    );
  }
  const githubUsername = normalizeGithubUsername(githubUsernameSource);
  return {
    clerkUserId: user.id,
    githubUserId: githubAccount.providerUserId,
    githubUsername,
    githubUsernameFingerprint: hashToken(githubUsername).slice(0, 16),
  } satisfies ClerkIdentity;
}).pipe(
  Effect.tap((identity) =>
    Effect.logInfo("identity.clerk.verified").pipe(
      Effect.annotateLogs({
        clerkUserId: identity.clerkUserId,
        githubUsernameFingerprint: identity.githubUsernameFingerprint,
      })
    )
  ),
  Effect.withSpan("identity.clerk.get")
);

export const requireAdminIdentity = Effect.gen(function* () {
  const identity = yield* getClerkIdentity();
  const config = yield* AppConfigService;
  if (!config.adminGithubUsers.includes(identity.githubUsername)) {
    return yield* Effect.fail(
      new AdminAccessDeniedError({ message: "This account is not an administrator." })
    );
  }
  return identity;
}).pipe(Effect.withSpan("identity.admin.require"));

export function normalizeGithubUsername(username: string): string {
  return username.trim().replace(/^@/, "").toLowerCase();
}
