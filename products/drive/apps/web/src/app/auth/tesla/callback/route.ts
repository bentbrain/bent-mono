import { randomUUID } from "node:crypto";

import { Data, Effect, Either } from "effect";

import { AppConfigService } from "@/lib/config";
import { hashToken, randomToken } from "@/lib/crypto";
import { completeTeslaAuthorization } from "@/lib/db/store";
import { openAuthorizeState, redirectWithOAuthResult } from "@/lib/oauth";
import { runAppResponse } from "@/lib/runtime";
import { exchangeTeslaAuthorizationCode } from "@/lib/tesla";

export const runtime = "nodejs";

class CallbackStateError extends Data.TaggedError("CallbackStateError")<{
  message: string;
}> {}

class AuthorizationCodeGenerationError extends Data.TaggedError(
  "AuthorizationCodeGenerationError"
)<{ message: string }> {}

export function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const program = Effect.gen(function* () {
    const sealedState = url.searchParams.get("state");
    if (!sealedState) {
      return Response.json({ error: "missing_state" }, { status: 400 });
    }

    const config = yield* AppConfigService;
    const stateResult = yield* Effect.either(
      Effect.try({
        try: () => openAuthorizeState(sealedState, config),
        catch: (error) =>
          new CallbackStateError({
            message: error instanceof Error ? error.message : "Invalid authorization state.",
          }),
      }).pipe(Effect.withSpan("oauth.callback.open_state"))
    );
    if (Either.isLeft(stateResult)) {
      return Response.json(
        { error: "invalid_state", error_description: stateResult.left.message },
        { status: 400 }
      );
    }
    const state = stateResult.right;

    const upstreamError = url.searchParams.get("error");
    if (upstreamError) {
      return redirectWithOAuthResult(state.redirectUri, state.clientState, {
        error: "access_denied",
        description: url.searchParams.get("error_description") ?? upstreamError,
      });
    }
    const code = url.searchParams.get("code");
    if (!code) {
      return redirectWithOAuthResult(state.redirectUri, state.clientState, {
        error: "server_error",
        description: "Tesla did not return an authorization code.",
      });
    }

    const completion = Effect.gen(function* () {
      const connection = yield* exchangeTeslaAuthorizationCode(code);
      const authorizationCode = yield* Effect.try({
        try: () => randomToken("tbc_code_"),
        catch: (error) =>
          new AuthorizationCodeGenerationError({
            message: error instanceof Error ? error.message : "Could not generate an OAuth code.",
          }),
      }).pipe(Effect.withSpan("oauth.callback.generate_code"));
      yield* completeTeslaAuthorization(
        connection,
        state.userId,
        hashToken(authorizationCode),
        {
          clientId: state.clientId,
          connectionId: connection.id,
          redirectUri: state.redirectUri,
          resource: state.resource,
          scopes: state.scopes,
          codeChallenge: state.codeChallenge,
        },
        Math.floor(Date.now() / 1000) + 5 * 60,
        randomUUID()
      );
      return { connectionId: connection.id, authorizationCode };
    });

    const completionResult = yield* Effect.either(completion);
    if (Either.isLeft(completionResult)) {
      yield* Effect.logError("oauth.callback.failed").pipe(
        Effect.annotateLogs({ clientId: state.clientId })
      );
      return redirectWithOAuthResult(state.redirectUri, state.clientState, {
        error: "server_error",
        description: "Bent Drive Copilot could not complete the Tesla connection.",
      });
    }

    yield* Effect.logInfo("oauth.callback.completed").pipe(
      Effect.annotateLogs({
        clientId: state.clientId,
        connectionId: completionResult.right.connectionId,
      })
    );
    return redirectWithOAuthResult(state.redirectUri, state.clientState, {
      code: completionResult.right.authorizationCode,
    });
  });

  return runAppResponse("route.tesla.callback", program, {
    "http.request.method": request.method,
  });
}
