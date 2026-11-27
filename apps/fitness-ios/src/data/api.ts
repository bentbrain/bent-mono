import { ApiError as ApiErrorBody, AppRecords, PhotoList } from "@bent/fitness-contracts";
import type { PhotoSummary, PhotoUpload } from "@bent/fitness-contracts";
import { resultSchema } from "@bent/fitness-contracts/domain";
import type { Mutation, SaveResult } from "@bent/fitness-contracts/domain";
import { OfflineError } from "./sync-engine";

/** A reply from Fitness that was not a success. `message` is safe to show. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
  }
}

export type TokenSource = {
  token(options?: { fresh?: boolean; generation?: number }): Promise<string>;
  invalidate(token: string): void;
  /** Changes at each sign-in and sign-out. */
  generation(): number;
};

/** Thrown for a reply that arrived after the sign-in it was sent for ended. */
export class SignedOutError extends Error {
  constructor() {
    super("Your Fitness sign-in changed. Sign in again to continue.");
  }
}

/**
 * The Fitness app API under `/api/app`. Each request sends the account's
 * access token. A `401` refreshes the token once and tries again. A request
 * belongs to the sign-in it started under: it never retries with, or
 * returns a reply to, a later sign-in.
 */
export function createApi(
  origin: string,
  session: TokenSource,
  request: (url: string, init?: RequestInit) => Promise<Response> = fetch,
) {
  async function send(
    path: string,
    init: RequestInit = {},
    generation = session.generation(),
    retried = false,
  ): Promise<Response> {
    const token = await session.token({ generation });
    if (generation !== session.generation()) throw new SignedOutError();
    let response: Response;
    try {
      response = await request(origin + path, {
        ...init,
        headers: { Accept: "application/json", ...init.headers, Authorization: `Bearer ${token}` },
      });
    } catch {
      if (generation !== session.generation()) throw new SignedOutError();
      throw new OfflineError();
    }
    if (generation !== session.generation()) throw new SignedOutError();
    if (response.status === 401 && !retried) {
      session.invalidate(token);
      return send(path, init, generation, true);
    }
    if (!response.ok) {
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      const parsed = ApiErrorBody.safeParse(body);
      throw new ApiError(
        response.status,
        parsed.success ? (parsed.data.code ?? null) : null,
        parsed.success ? parsed.data.error : `Fitness replied ${response.status}. Try again shortly.`,
      );
    }
    return response;
  }
  /**
   * Sends a request and reads its reply with `parse`. The sign-in is checked
   * again once the body is read, so a reply for an earlier sign-in is never
   * returned to a later one.
   */
  async function read<T>(path: string, init: RequestInit, parse: (response: Response) => Promise<T>): Promise<T> {
    const generation = session.generation();
    const value = await parse(await send(path, init, generation));
    if (generation !== session.generation()) throw new SignedOutError();
    return value;
  }
  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return {
    async loadRecords() {
      return read("/api/app/records", {}, async (response) => AppRecords.parse(await response.json()));
    },
    async saveRecord(mutation: Mutation): Promise<SaveResult> {
      return read("/api/app/records", json(mutation), async (response) => resultSchema.parse(await response.json()));
    },
    async listPhotos(): Promise<PhotoSummary[]> {
      return read("/api/app/photos", {}, async (response) => PhotoList.parse(await response.json()).photos);
    },
    async uploadPhoto(photo: PhotoUpload) {
      await read("/api/app/photos", json(photo), async () => undefined);
    },
    async deletePhoto(id: string) {
      await read(`/api/app/photos/${encodeURIComponent(id)}`, { method: "DELETE" }, async () => undefined);
    },
    /** The photo's URL and the headers that authorize loading it. */
    async photoSource(id: string) {
      return {
        uri: `${origin}/api/app/photos/${encodeURIComponent(id)}`,
        headers: { Authorization: `Bearer ${await session.token({ generation: session.generation() })}` },
      };
    },
    /** The account export as text. */
    async exportAccount() {
      return read("/api/app/export", {}, (response) => response.text());
    },
  };
}

export type Api = ReturnType<typeof createApi>;
