import { fitnessScopes, PhotoUpload } from "@bent/fitness-contracts";
import type { ApiErrorCode } from "@bent/fitness-contracts";
import { mutationSchema } from "@bent/fitness-contracts/domain";
import { z } from "zod";
import { invitedEmail, verifyBearer } from "./auth";
import { readBodyUpTo } from "./body";
import { deviceClientIds } from "./config";
import { exportResponse } from "./export";
import {
  PhotoRuleError,
  photoList,
  photoRemove,
  photoResponse,
  photoSave,
} from "./photos";
import { StoreRuleError, loadRecords, saveRecord } from "./store";

/**
 * The bent Fitness iPhone app's API under `/api/app`. Each request carries
 * an OAuth access token that Clerk issued to one of the app's OAuth
 * applications (`FITNESS_DEVICE_CLIENT_IDS`) for the MCP endpoint. Reads
 * need `fitness:read`. Saving a record needs both scopes, since its reply
 * can carry the current record. Photo changes need `fitness:write`. API
 * keys, device keys, other OAuth clients and browser sessions are refused.
 */
type Need = "read" | "write";
const noStore = { "Cache-Control": "no-store" };
/**
 * Body limits. A record change carries the whole record, and valid settings
 * can run to several megabytes, so record changes may use the 4.5 MB a
 * Vercel function accepts. Photos are at most 2 MB before base64.
 */
const limits = { record: 4.5 * 1024 * 1024, photo: 3 * 1024 * 1024 };
/** The time authentication may take in all, Clerk lookups included. */
const timing = { authMs: 10_000 };
const defaultTiming = { ...timing };
/** Sets the authentication deadline, or restores the default, for tests. */
export function setAppTimingForTests(changes: Partial<typeof timing> = {}) {
  Object.assign(timing, defaultTiming, changes);
}
class AuthTimeout extends Error {}
/** Waits for `call` until `deadline` on the monotonic clock. */
function until<T>(call: () => Promise<T>, deadline: number): Promise<T> {
  const ms = deadline - performance.now();
  if (ms <= 0) return Promise.reject(new AuthTimeout());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AuthTimeout()), ms);
  });
  return Promise.race([call(), timeout]).finally(() => clearTimeout(timer));
}

function json(value: unknown, status = 200, headers: HeadersInit = {}) {
  return Response.json(value, { status, headers: { ...noStore, ...headers } });
}
function failure(error: string, code: ApiErrorCode, status: number) {
  const headers: HeadersInit =
    status === 401
      ? { "WWW-Authenticate": `Bearer error="invalid_token"` }
      : status === 403 && code === "insufficient_scope"
        ? {
            "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${fitnessScopes.read} ${fitnessScopes.write}"`,
          }
        : {};
  return json({ error, code }, status, headers);
}
const unavailable = () =>
  failure(
    "Account services are unavailable. Try again shortly.",
    "auth_unavailable",
    503,
  );

/** The invited owner of the request's app token, or the reply that refuses it. */
async function authenticateApp(
  request: Request,
  needs: Need[],
): Promise<{ ok: true; owner: string } | { ok: false; response: Response }> {
  const refuse = (response: Response) => ({ ok: false as const, response });
  const deadline = performance.now() + timing.authMs;
  const check = await verifyBearer(request, ["oauth_token"], {
    timeoutMs: timing.authMs,
  });
  if (!check.ok) {
    if (check.failure === "unconfigured" || check.failure === "unavailable")
      return refuse(unavailable());
    return refuse(failure("Sign in to Fitness again.", "unauthorized", 401));
  }
  const { bearer } = check;
  if (!bearer.userId?.startsWith("user_"))
    return refuse(
      failure(
        "Use a token that belongs to a Fitness account.",
        "unauthorized",
        401,
      ),
    );
  if (!bearer.clientId || !deviceClientIds().has(bearer.clientId))
    return refuse(
      failure(
        "Only the bent Fitness app can use this endpoint.",
        "client_not_allowed",
        403,
      ),
    );
  const scopes = needs.map((need) =>
    need === "read" ? fitnessScopes.read : fitnessScopes.write,
  );
  if (!scopes.every((scope) => bearer.scopes.includes(scope)))
    return refuse(
      failure(
        "Approve Fitness read and write access when you sign in.",
        "insufficient_scope",
        403,
      ),
    );
  let email: string | null;
  try {
    const userId = bearer.userId;
    email = await until(() => invitedEmail(userId), deadline);
  } catch {
    return refuse(unavailable());
  }
  if (!email)
    return refuse(
      failure(
        "This account needs an invitation. Contact the app owner.",
        "not_invited",
        403,
      ),
    );
  return { ok: true, owner: bearer.userId };
}

/** A JSON body up to `limit` bytes, parsed with `schema`. */
async function readJson<T>(
  request: Request,
  limit: number,
  schema: z.ZodType<T>,
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  const text = await readBodyUpTo(request, limit);
  if (text === null)
    return {
      ok: false,
      response: failure("The request is too large.", "payload_too_large", 413),
    };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      ok: false,
      response: failure("Send a JSON body.", "invalid_request", 400),
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    return {
      ok: false,
      response: failure(
        parsed.error.issues[0]?.message ?? "Check the values and try again.",
        "invalid_request",
        400,
      ),
    };
  return { ok: true, value: parsed.data };
}

/** Runs a handler, replying with a safe message for rule errors and 500 otherwise. */
async function guarded(work: () => Promise<Response>) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof StoreRuleError || error instanceof PhotoRuleError)
      return failure(error.message, "invalid_request", 422);
    console.error("fitness.app.failed", {
      name: error instanceof Error ? error.name : typeof error,
    });
    return failure(
      "Fitness had a problem. Try again shortly.",
      "server_error",
      500,
    );
  }
}

/** `GET /api/app/records`: the owner and every record. */
export async function handleRecordsLoad(request: Request) {
  const auth = await authenticateApp(request, ["read"]);
  if (!auth.ok) return auth.response;
  return guarded(async () =>
    json({ owner: auth.owner, records: await loadRecords(auth.owner) }),
  );
}

/**
 * `POST /api/app/records`: saves one mutation. The reply is the save
 * result, including `conflict` with the current record, as the web app
 * receives it.
 */
export async function handleRecordSave(request: Request) {
  const auth = await authenticateApp(request, ["read", "write"]);
  if (!auth.ok) return auth.response;
  const body = await readJson(request, limits.record, mutationSchema);
  if (!body.ok) return body.response;
  return guarded(async () => json(await saveRecord(auth.owner, body.value)));
}

/** `GET /api/app/photos`: the owner's equipment photos. */
export async function handlePhotoList(request: Request) {
  const auth = await authenticateApp(request, ["read"]);
  if (!auth.ok) return auth.response;
  return guarded(async () => json({ photos: await photoList(auth.owner) }));
}

/** `POST /api/app/photos`: saves one photo; a repeated ID saves once. */
export async function handlePhotoUpload(request: Request) {
  const auth = await authenticateApp(request, ["write"]);
  if (!auth.ok) return auth.response;
  const body = await readJson(request, limits.photo, PhotoUpload);
  if (!body.ok) return body.response;
  return guarded(async () => json(await photoSave(auth.owner, body.value)));
}

const photoId = z.uuid();

/** `GET /api/app/photos/:id`: the photo's bytes. */
export async function handlePhotoRead(request: Request, id: string) {
  const auth = await authenticateApp(request, ["read"]);
  if (!auth.ok) return auth.response;
  const parsed = photoId.safeParse(id);
  if (!parsed.success)
    return failure("Photo not found.", "invalid_request", 404);
  return guarded(() => photoResponse(auth.owner, parsed.data));
}

/** `DELETE /api/app/photos/:id`: removes the photo. */
export async function handlePhotoDelete(request: Request, id: string) {
  const auth = await authenticateApp(request, ["write"]);
  if (!auth.ok) return auth.response;
  const parsed = photoId.safeParse(id);
  if (!parsed.success)
    return failure("Photo not found.", "invalid_request", 404);
  return guarded(async () => json(await photoRemove(auth.owner, parsed.data)));
}

/** `GET /api/app/export`: the `bent-fitness-v1` account export. */
export async function handleExport(request: Request) {
  const auth = await authenticateApp(request, ["read"]);
  if (!auth.ok) return auth.response;
  return guarded(async () => exportResponse(auth.owner));
}
