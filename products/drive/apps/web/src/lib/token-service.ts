import { Data, Effect } from "effect";

import { AppConfigService } from "./config";
import { hashToken, randomToken } from "./crypto";

import type { OAuthTokenMaterial, OAuthTokenRecord } from "./db/store";

class OAuthTokenGenerationError extends Data.TaggedError("OAuthTokenGenerationError")<{
  message: string;
}> {}

export interface IssuedOAuthTokens {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
}

interface PreparedOAuthTokens {
  material: OAuthTokenMaterial;
  response: IssuedOAuthTokens;
}

export const prepareOAuthTokens = (scopes: string, nowEpoch?: number) =>
  Effect.gen(function* () {
    const config = yield* AppConfigService;
    const issuedAtEpoch = nowEpoch ?? (yield* currentEpochSeconds);
    const tokens = yield* Effect.try({
      try: () => {
        const accessToken = randomToken("tbc_at_");
        const refreshToken = randomToken("tbc_rt_");
        return {
          accessToken,
          refreshToken,
          accessTokenHash: hashToken(accessToken),
          refreshTokenHash: hashToken(refreshToken),
        };
      },
      catch: (cause) => new OAuthTokenGenerationError({ message: causeMessage(cause) }),
    }).pipe(Effect.withSpan("oauth.tokens.generate"));

    return {
      material: {
        accessTokenHash: tokens.accessTokenHash,
        refreshTokenHash: tokens.refreshTokenHash,
        accessExpiresAtEpoch: issuedAtEpoch + config.mcpAccessTokenTtlSeconds,
        refreshExpiresAtEpoch: issuedAtEpoch + config.mcpRefreshTokenTtlSeconds,
      },
      response: {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_type: "Bearer",
        expires_in: config.mcpAccessTokenTtlSeconds,
        scope: scopes,
      },
    } satisfies PreparedOAuthTokens;
  }).pipe(
    Effect.annotateSpans({ "oauth.scopes": scopes }),
    Effect.withSpan("oauth.tokens.prepare")
  );

export const logOAuthTokensIssued = (record: OAuthTokenRecord) =>
  Effect.logInfo("oauth.tokens.issued").pipe(
    Effect.annotateLogs({ clientId: record.clientId, connectionId: record.connectionId }),
    Effect.withSpan("oauth.tokens.issued")
  );

const currentEpochSeconds = Effect.sync(() => Math.floor(Date.now() / 1_000)).pipe(
  Effect.withSpan("oauth.clock.epoch_seconds")
);

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
