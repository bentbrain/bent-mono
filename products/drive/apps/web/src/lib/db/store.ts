import * as PgClient from "@effect/sql-pg/PgClient";
import { Data, Effect } from "effect";
import { z } from "zod";

const epochSchema = z.coerce.number().finite();

const oauthClientRowSchema = z.object({
  client_id: z.string().min(1),
  redirect_uris: z.array(z.string().url()),
  client_name: z.string().nullable(),
});

const authorizationCodeRowSchema = z.object({
  client_id: z.string().min(1),
  connection_id: z.string().min(1),
  redirect_uri: z.string().url(),
  resource: z.string().url(),
  scopes: z.string().min(1),
  code_challenge: z.string().min(1),
});

const refreshTokenRowSchema = z.object({
  client_id: z.string().min(1),
  connection_id: z.string().min(1),
  resource: z.string().url(),
  scopes: z.string().min(1),
});

const refreshTokenRotationRowSchema = refreshTokenRowSchema.extend({
  family_id: z.string().min(1),
  is_used: z.boolean(),
  is_revoked: z.boolean(),
  is_expired: z.boolean(),
});

const accessSessionRowSchema = refreshTokenRowSchema.extend({
  expires_at_epoch: epochSchema,
});

const appUserRowSchema = z.object({
  id: z.string().uuid(),
  clerk_user_id: z.string().min(1),
  github_username: z.string().min(1),
  github_user_id: z.string().min(1),
  role: z.enum(["admin", "member"]),
  status: z.enum(["active", "revoked"]),
});

const inviteRowSchema = z.object({
  id: z.string().uuid(),
  github_username: z.string().min(1),
  status: z.enum(["pending", "accepted", "revoked"]),
  expires_at_epoch: epochSchema,
  accepted_at_epoch: epochSchema.nullable(),
  revoked_at_epoch: epochSchema.nullable(),
  created_at_epoch: epochSchema,
});

const inviteAuthorizationRowSchema = z.object({
  id: z.string().uuid(),
});

const revokedInviteRowSchema = z.object({
  accepted_by_user_id: z.string().uuid().nullable(),
});

const teslaConnectionRowSchema = z.object({
  id: z.string().min(1),
  access_token_encrypted: z.string().min(1),
  refresh_token_encrypted: z.string().min(1),
  token_version: z.coerce.number().int().positive(),
  scopes: z.string().min(1),
  expires_at_epoch: epochSchema,
});

class StoreDecodeError extends Data.TaggedError("StoreDecodeError")<{
  entity: string;
  message: string;
}> {}

interface OAuthClient {
  clientId: string;
  redirectUris: string[];
  clientName: string | null;
}

export interface AuthorizationCodeRecord {
  clientId: string;
  connectionId: string;
  redirectUri: string;
  resource: string;
  scopes: string;
  codeChallenge: string;
}

export interface OAuthTokenRecord {
  clientId: string;
  connectionId: string;
  resource: string;
  scopes: string;
}

interface AccessSession extends OAuthTokenRecord {
  expiresAtEpoch: number;
}

export interface AppUser {
  id: string;
  clerkUserId: string;
  githubUsername: string;
  githubUserId: string;
  role: "admin" | "member";
  status: "active" | "revoked";
}

export interface Invite {
  id: string;
  githubUsername: string;
  status: "pending" | "accepted" | "revoked";
  expiresAtEpoch: number;
  acceptedAtEpoch: number | null;
  revokedAtEpoch: number | null;
  createdAtEpoch: number;
}

export interface TeslaConnection {
  id: string;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  tokenVersion: number;
  scopes: string;
  expiresAtEpoch: number;
}

export interface OAuthTokenMaterial {
  accessTokenHash: string;
  refreshTokenHash: string;
  accessExpiresAtEpoch: number;
  refreshExpiresAtEpoch: number;
}

type RefreshTokenRotation =
  | { status: "rotated"; record: OAuthTokenRecord }
  | { status: "replayed" }
  | { status: "invalid" };

export const registerOAuthClient = (
  clientId: string,
  redirectUris: string[],
  clientName: string | null
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`
      INSERT INTO oauth_clients (client_id, redirect_uris, client_name)
      VALUES (${clientId}, ${JSON.stringify(redirectUris)}::jsonb, ${clientName})
    `;
  }).pipe(
    Effect.withSpan("db.oauth_client.register", { attributes: { "oauth.client_id": clientId } })
  );

export const getOAuthClient = (clientId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<Record<string, unknown>>`
      SELECT client_id, redirect_uris, client_name
      FROM oauth_clients
      WHERE client_id = ${clientId}
      LIMIT 1
    `;
    const row = yield* decodeOptional(oauthClientRowSchema, rows[0], "oauth_client");
    if (!row) {
      return null;
    }
    return {
      clientId: row.client_id,
      redirectUris: row.redirect_uris,
      clientName: row.client_name,
    } satisfies OAuthClient;
  }).pipe(Effect.withSpan("db.oauth_client.get", { attributes: { "oauth.client_id": clientId } }));

export const completeTeslaAuthorization = (
  connection: TeslaConnection,
  userId: string,
  codeHash: string,
  record: AuthorizationCodeRecord,
  codeExpiresAtEpoch: number,
  auditEventId: string
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO tesla_connections (
            id, user_id, access_token_encrypted, refresh_token_encrypted, token_version, scopes,
            expires_at
          ) VALUES (
            ${connection.id}, ${userId}, ${connection.accessTokenEncrypted},
            ${connection.refreshTokenEncrypted}, ${connection.tokenVersion}, ${connection.scopes},
            TO_TIMESTAMP(${connection.expiresAtEpoch})
          )
        `;
        yield* sql`
          INSERT INTO oauth_authorization_codes (
            code_hash, client_id, connection_id, redirect_uri, resource, scopes,
            code_challenge, expires_at
          ) VALUES (
            ${codeHash}, ${record.clientId}, ${connection.id}, ${record.redirectUri},
            ${record.resource}, ${record.scopes}, ${record.codeChallenge},
            TO_TIMESTAMP(${codeExpiresAtEpoch})
          )
        `;
        yield* sql`
          INSERT INTO audit_events (id, connection_id, event_type, details)
          VALUES (
            ${auditEventId}, ${connection.id}, 'tesla.oauth.connected',
            ${JSON.stringify({ clientId: record.clientId, scopes: record.scopes })}::jsonb
          )
        `;
      })
    );
  }).pipe(
    Effect.withSpan("db.tesla_authorization.complete", {
      attributes: {
        "oauth.client_id": record.clientId,
        "tesla.connection_id": connection.id,
      },
    })
  );

export const getTeslaConnection = (connectionId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<Record<string, unknown>>`
      SELECT
        id,
        access_token_encrypted,
        refresh_token_encrypted,
        token_version,
        scopes,
        EXTRACT(EPOCH FROM expires_at) AS expires_at_epoch
      FROM tesla_connections
      WHERE id = ${connectionId}
      LIMIT 1
    `;
    const row = yield* decodeOptional(teslaConnectionRowSchema, rows[0], "tesla_connection");
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      accessTokenEncrypted: row.access_token_encrypted,
      refreshTokenEncrypted: row.refresh_token_encrypted,
      tokenVersion: row.token_version,
      scopes: row.scopes,
      expiresAtEpoch: row.expires_at_epoch,
    } satisfies TeslaConnection;
  }).pipe(
    Effect.withSpan("db.tesla_connection.get", {
      attributes: { "tesla.connection_id": connectionId },
    })
  );

export const updateTeslaConnectionTokens = (
  connectionId: string,
  expectedVersion: number,
  accessTokenEncrypted: string,
  refreshTokenEncrypted: string,
  scopes: string,
  expiresAtEpoch: number
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<Record<string, unknown>>`
      UPDATE tesla_connections
      SET
        access_token_encrypted = ${accessTokenEncrypted},
        refresh_token_encrypted = ${refreshTokenEncrypted},
        token_version = token_version + 1,
        scopes = ${scopes},
        expires_at = TO_TIMESTAMP(${expiresAtEpoch}),
        updated_at = NOW()
      WHERE id = ${connectionId} AND token_version = ${expectedVersion}
      RETURNING id
    `;
    return rows.length === 1;
  }).pipe(
    Effect.withSpan("db.tesla_connection.rotate_tokens", {
      attributes: {
        "tesla.connection_id": connectionId,
        "tesla.token_version": expectedVersion,
      },
    })
  );

export const exchangeAuthorizationCodeForTokens = (
  codeHash: string,
  clientId: string,
  redirectUri: string,
  resource: string,
  codeChallenge: string,
  tokens: OAuthTokenMaterial
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<Record<string, unknown>>`
          UPDATE oauth_authorization_codes
          SET used_at = NOW()
          WHERE code_hash = ${codeHash}
            AND client_id = ${clientId}
            AND redirect_uri = ${redirectUri}
            AND resource = ${resource}
            AND code_challenge = ${codeChallenge}
            AND used_at IS NULL
            AND expires_at > NOW()
          RETURNING client_id, connection_id, redirect_uri, resource, scopes, code_challenge
        `;
        const row = yield* decodeOptional(authorizationCodeRowSchema, rows[0], "oauth_code");
        if (!row) {
          return null;
        }
        const record: OAuthTokenRecord = {
          clientId: row.client_id,
          connectionId: row.connection_id,
          resource: row.resource,
          scopes: row.scopes,
        };
        yield* sql`
          INSERT INTO oauth_access_tokens (
            token_hash, client_id, connection_id, resource, scopes, family_id, expires_at
          ) VALUES (
            ${tokens.accessTokenHash}, ${record.clientId}, ${record.connectionId},
            ${record.resource}, ${record.scopes}, ${tokens.refreshTokenHash},
            TO_TIMESTAMP(${tokens.accessExpiresAtEpoch})
          )
        `;
        yield* sql`
          INSERT INTO oauth_refresh_tokens (
            token_hash, client_id, connection_id, resource, scopes, family_id, expires_at
          ) VALUES (
            ${tokens.refreshTokenHash}, ${record.clientId}, ${record.connectionId},
            ${record.resource}, ${record.scopes}, ${tokens.refreshTokenHash},
            TO_TIMESTAMP(${tokens.refreshExpiresAtEpoch})
          )
        `;
        return record;
      })
    );
  }).pipe(
    Effect.withSpan("db.oauth_code.exchange", {
      attributes: { "oauth.client_id": clientId },
    })
  );

export const rotateRefreshToken = (
  refreshTokenHash: string,
  clientId: string,
  resource: string,
  tokens: OAuthTokenMaterial
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<Record<string, unknown>>`
          SELECT
            rt.client_id,
            rt.connection_id,
            rt.resource,
            rt.scopes,
            rt.family_id,
            rt.used_at IS NOT NULL AS is_used,
            rt.revoked_at IS NOT NULL AS is_revoked,
            rt.expires_at <= NOW() AS is_expired
          FROM oauth_refresh_tokens rt
          INNER JOIN tesla_connections tc ON tc.id = rt.connection_id
          INNER JOIN app_users au ON au.id = tc.user_id AND au.status = 'active'
          WHERE rt.token_hash = ${refreshTokenHash}
            AND rt.client_id = ${clientId}
            AND rt.resource = ${resource}
          FOR UPDATE
        `;
        const row = yield* decodeOptional(
          refreshTokenRotationRowSchema,
          rows[0],
          "oauth_refresh_token"
        );
        if (!row) {
          return { status: "invalid" } satisfies RefreshTokenRotation;
        }
        if (row.is_used) {
          yield* Effect.all(
            [
              sql`
                UPDATE oauth_refresh_tokens
                SET revoked_at = COALESCE(revoked_at, NOW())
                WHERE family_id = ${row.family_id}
              `,
              sql`
                UPDATE oauth_access_tokens
                SET revoked_at = COALESCE(revoked_at, NOW())
                WHERE family_id = ${row.family_id}
              `,
            ],
            { discard: true }
          );
          return { status: "replayed" } satisfies RefreshTokenRotation;
        }
        if (row.is_revoked || row.is_expired) {
          return { status: "invalid" } satisfies RefreshTokenRotation;
        }
        const record: OAuthTokenRecord = {
          clientId: row.client_id,
          connectionId: row.connection_id,
          resource: row.resource,
          scopes: row.scopes,
        };
        yield* sql`
          UPDATE oauth_refresh_tokens
          SET used_at = NOW(), successor_token_hash = ${tokens.refreshTokenHash}
          WHERE token_hash = ${refreshTokenHash}
        `;
        yield* sql`
          INSERT INTO oauth_access_tokens (
            token_hash, client_id, connection_id, resource, scopes, family_id, expires_at
          ) VALUES (
            ${tokens.accessTokenHash}, ${record.clientId}, ${record.connectionId},
            ${record.resource}, ${record.scopes}, ${row.family_id},
            TO_TIMESTAMP(${tokens.accessExpiresAtEpoch})
          )
        `;
        yield* sql`
          INSERT INTO oauth_refresh_tokens (
            token_hash, client_id, connection_id, resource, scopes, family_id, expires_at
          ) VALUES (
            ${tokens.refreshTokenHash}, ${record.clientId}, ${record.connectionId},
            ${record.resource}, ${record.scopes}, ${row.family_id},
            TO_TIMESTAMP(${tokens.refreshExpiresAtEpoch})
          )
        `;
        return { status: "rotated", record } satisfies RefreshTokenRotation;
      })
    );
  }).pipe(
    Effect.withSpan("db.oauth_refresh_token.rotate", {
      attributes: { "oauth.client_id": clientId },
    })
  );

export const getAccessSession = (accessTokenHash: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<Record<string, unknown>>`
      SELECT
        oat.client_id,
        oat.connection_id,
        oat.resource,
        oat.scopes,
        EXTRACT(EPOCH FROM oat.expires_at) AS expires_at_epoch
      FROM oauth_access_tokens oat
      INNER JOIN tesla_connections tc ON tc.id = oat.connection_id
      INNER JOIN app_users au ON au.id = tc.user_id AND au.status = 'active'
      WHERE oat.token_hash = ${accessTokenHash}
        AND oat.expires_at > NOW()
        AND oat.revoked_at IS NULL
      LIMIT 1
    `;
    const row = yield* decodeOptional(accessSessionRowSchema, rows[0], "oauth_access_token");
    if (!row) {
      return null;
    }
    return {
      clientId: row.client_id,
      connectionId: row.connection_id,
      resource: row.resource,
      scopes: row.scopes,
      expiresAtEpoch: row.expires_at_epoch,
    } satisfies AccessSession;
  }).pipe(Effect.withSpan("db.oauth_access_token.get"));

export const authorizeGithubIdentity = (
  newUserId: string,
  clerkUserId: string,
  githubUsername: string,
  githubUserId: string,
  isAdmin: boolean,
  isAllowlisted: boolean
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const existingRows = yield* sql<Record<string, unknown>>`
          SELECT id, clerk_user_id, github_username, github_user_id, role, status
          FROM app_users
          WHERE clerk_user_id = ${clerkUserId} OR github_user_id = ${githubUserId}
          ORDER BY (clerk_user_id = ${clerkUserId}) DESC
          LIMIT 1
          FOR UPDATE
        `;
        const existing = yield* decodeOptional(appUserRowSchema, existingRows[0], "app_user");
        const existingIsAuthorized = existing?.status === "active";
        const inviteRows = isAdmin || isAllowlisted || existingIsAuthorized
          ? []
          : yield* sql<Record<string, unknown>>`
              SELECT id
              FROM invites
              WHERE github_username = ${githubUsername}
                AND status = 'pending'
                AND revoked_at IS NULL
                AND expires_at > NOW()
              LIMIT 1
              FOR UPDATE
            `;
        const invite = yield* decodeOptional(
          inviteAuthorizationRowSchema,
          inviteRows[0],
          "invite_authorization"
        );
        if (!isAdmin && !isAllowlisted && !existingIsAuthorized && !invite) {
          return null;
        }

        const role = isAdmin ? "admin" : "member";
        const userRows = existing
          ? yield* sql<Record<string, unknown>>`
              UPDATE app_users
              SET
                clerk_user_id = ${clerkUserId},
                github_username = ${githubUsername},
                github_user_id = ${githubUserId},
                role = ${role},
                status = 'active',
                updated_at = NOW()
              WHERE id = ${existing.id}
              RETURNING id, clerk_user_id, github_username, github_user_id, role, status
            `
          : yield* sql<Record<string, unknown>>`
              INSERT INTO app_users (
                id, clerk_user_id, github_username, github_user_id, role, status
              )
              VALUES (
                ${newUserId}, ${clerkUserId}, ${githubUsername}, ${githubUserId}, ${role}, 'active'
              )
              RETURNING id, clerk_user_id, github_username, github_user_id, role, status
            `;
        const user = yield* decodeRequired(appUserRowSchema, userRows[0], "app_user");

        if (invite) {
          yield* sql`
            UPDATE invites
            SET
              status = 'accepted',
              accepted_by_user_id = ${user.id},
              accepted_at = COALESCE(accepted_at, NOW()),
              updated_at = NOW()
            WHERE id = ${invite.id}
          `;
        }
        return toAppUser(user);
      })
    );
  }).pipe(
    Effect.annotateSpans({
      "identity.clerk_user_id": clerkUserId,
      "identity.github_user_id": githubUserId,
      "identity.is_admin": isAdmin,
      "identity.is_allowlisted": isAllowlisted,
    }),
    Effect.withSpan("db.identity.authorize")
  );

export const listInvites = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const rows = yield* sql<Record<string, unknown>>`
    SELECT
      id,
      github_username,
      status,
      EXTRACT(EPOCH FROM expires_at) AS expires_at_epoch,
      EXTRACT(EPOCH FROM accepted_at) AS accepted_at_epoch,
      EXTRACT(EPOCH FROM revoked_at) AS revoked_at_epoch,
      EXTRACT(EPOCH FROM created_at) AS created_at_epoch
    FROM invites
    ORDER BY created_at DESC
  `;
  return yield* Effect.forEach(rows, (row) =>
    decodeRequired(inviteRowSchema, row, "invite").pipe(Effect.map(toInvite))
  );
}).pipe(Effect.withSpan("db.invite.list"));

export const createInvite = (
  inviteId: string,
  githubUsername: string,
  expiresAtEpoch: number,
  auditEventId: string,
  createdByClerkUserId: string,
  githubUsernameFingerprint: string
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<Record<string, unknown>>`
          INSERT INTO invites (id, github_username, status, expires_at)
          VALUES (${inviteId}, ${githubUsername}, 'pending', TO_TIMESTAMP(${expiresAtEpoch}))
          ON CONFLICT (github_username) WHERE github_username IS NOT NULL DO UPDATE
          SET
            status = 'pending',
            expires_at = EXCLUDED.expires_at,
            accepted_by_user_id = NULL,
            accepted_at = NULL,
            revoked_at = NULL,
            updated_at = NOW()
          RETURNING
            id,
            github_username,
            status,
            EXTRACT(EPOCH FROM expires_at) AS expires_at_epoch,
            EXTRACT(EPOCH FROM accepted_at) AS accepted_at_epoch,
            EXTRACT(EPOCH FROM revoked_at) AS revoked_at_epoch,
            EXTRACT(EPOCH FROM created_at) AS created_at_epoch
        `;
        const invite = yield* decodeRequired(inviteRowSchema, rows[0], "invite");
        yield* sql`
          INSERT INTO audit_events (id, connection_id, event_type, details)
          VALUES (
            ${auditEventId},
            NULL,
            'invite.created',
            ${JSON.stringify({ createdByClerkUserId, githubUsernameFingerprint })}::jsonb
          )
        `;
        return toInvite(invite);
      })
    );
  }).pipe(
    Effect.annotateSpans({ "invite.github_username_fingerprint": githubUsernameFingerprint }),
    Effect.withSpan("db.invite.create")
  );

export const revokeInvite = (
  inviteId: string,
  auditEventId: string,
  revokedByClerkUserId: string
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const inviteRows = yield* sql<Record<string, unknown>>`
          UPDATE invites
          SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
          WHERE id = ${inviteId}
          RETURNING accepted_by_user_id
        `;
        const invite = yield* decodeOptional(revokedInviteRowSchema, inviteRows[0], "invite");
        if (!invite) {
          return false;
        }
        if (invite.accepted_by_user_id) {
          yield* sql`
            UPDATE app_users
            SET status = 'revoked', updated_at = NOW()
            WHERE id = ${invite.accepted_by_user_id} AND role <> 'admin'
          `;
        }
        yield* Effect.all(
          [
            sql`
              UPDATE oauth_access_tokens
              SET revoked_at = COALESCE(revoked_at, NOW())
              WHERE connection_id IN (
                SELECT tc.id
                FROM tesla_connections tc
                INNER JOIN app_users au ON au.id = tc.user_id
                WHERE au.id = ${invite.accepted_by_user_id} AND au.role <> 'admin'
              )
            `,
            sql`
              UPDATE oauth_refresh_tokens
              SET revoked_at = COALESCE(revoked_at, NOW())
              WHERE connection_id IN (
                SELECT tc.id
                FROM tesla_connections tc
                INNER JOIN app_users au ON au.id = tc.user_id
                WHERE au.id = ${invite.accepted_by_user_id} AND au.role <> 'admin'
              )
            `,
          ],
          { discard: true }
        );
        yield* sql`
          INSERT INTO audit_events (id, connection_id, event_type, details)
          VALUES (
            ${auditEventId},
            NULL,
            'invite.revoked',
            ${JSON.stringify({ inviteId, revokedByClerkUserId })}::jsonb
          )
        `;
        return true;
      })
    );
  }).pipe(
    Effect.annotateSpans({ "invite.id": inviteId }),
    Effect.withSpan("db.invite.revoke")
  );

function decodeOptional<A>(schema: z.ZodType<A>, value: unknown, entity: string) {
  if (value === undefined) {
    return Effect.succeed<A | null>(null);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return Effect.fail(
      new StoreDecodeError({
        entity,
        message: parsed.error.issues.map((issue) => issue.message).join("; "),
      })
    );
  }
  return Effect.succeed<A | null>(parsed.data);
}

function decodeRequired<A>(schema: z.ZodType<A>, value: unknown, entity: string) {
  if (value === undefined) {
    return Effect.fail(new StoreDecodeError({ entity, message: "The database returned no row." }));
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return Effect.fail(
      new StoreDecodeError({
        entity,
        message: parsed.error.issues.map((issue) => issue.message).join("; "),
      })
    );
  }
  return Effect.succeed(parsed.data);
}

function toAppUser(row: z.infer<typeof appUserRowSchema>): AppUser {
  return {
    id: row.id,
    clerkUserId: row.clerk_user_id,
    githubUsername: row.github_username,
    githubUserId: row.github_user_id,
    role: row.role,
    status: row.status,
  };
}

function toInvite(row: z.infer<typeof inviteRowSchema>): Invite {
  return {
    id: row.id,
    githubUsername: row.github_username,
    status: row.status,
    expiresAtEpoch: row.expires_at_epoch,
    acceptedAtEpoch: row.accepted_at_epoch,
    revokedAtEpoch: row.revoked_at_epoch,
    createdAtEpoch: row.created_at_epoch,
  };
}
