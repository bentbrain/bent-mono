import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
});

const storedTokenSchema = tokenResponseSchema.extend({
  expires_at: z.number().int().positive(),
});

export type StoredTeslaToken = z.infer<typeof storedTokenSchema>;

export class TeslaTokenStore {
  readonly #path: string;
  readonly #tokenEndpoint: string;
  readonly #fetch: typeof fetch;

  constructor(path: string, tokenEndpoint: string, fetcher: typeof fetch = fetch) {
    this.#path = path;
    this.#tokenEndpoint = tokenEndpoint;
    this.#fetch = fetcher;
  }

  async read(): Promise<StoredTeslaToken> {
    const contents = await readFile(this.#path, "utf8");
    const parsedJson: unknown = JSON.parse(contents);
    return storedTokenSchema.parse(parsedJson);
  }

  async saveResponse(response: unknown, now = Date.now()): Promise<StoredTeslaToken> {
    const token = tokenResponseSchema.parse(response);
    const stored = storedTokenSchema.parse({
      ...token,
      expires_at: now + token.expires_in * 1_000,
    });
    const directory = dirname(this.#path);
    const temporaryPath = join(directory, `.tokens-${randomUUID()}.json`);

    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.#path);
    await chmod(this.#path, 0o600);
    return stored;
  }

  async getAccessToken(clientId: string, now = Date.now()): Promise<string> {
    const token = await this.read();
    if (token.expires_at > now + 60_000) {
      return token.access_token;
    }
    return this.refresh(clientId);
  }

  async refresh(clientId: string): Promise<string> {
    const current = await this.read();
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: current.refresh_token,
    });
    const response = await this.#fetch(this.#tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const responseBody: unknown = await response.json();
    if (!response.ok) {
      throw new Error(`Tesla refresh-token exchange failed with HTTP ${response.status}.`);
    }
    const refreshed = await this.saveResponse(responseBody);
    return refreshed.access_token;
  }
}
