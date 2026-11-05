import { config as loadDotEnv } from "dotenv";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";

loadDotEnv({ path: ".env.local", quiet: true });
if (process.env.MIGRATION_ENV_FILE) {
  loadDotEnv({
    path: process.env.MIGRATION_ENV_FILE,
    quiet: true,
  });
}

export function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function databaseConnectionString(): string {
  const databaseUri = process.env.DATABASE_URI;
  if (databaseUri === undefined || databaseUri.length === 0) {
    return requiredEnvironment("DATABASE_URL");
  }
  return databaseUri;
}

export function uploadThingKeyFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.hostname !== "utfs.io" &&
      url.hostname !== "uploadthing.com" &&
      !url.hostname.endsWith(".ufs.sh")
    ) {
      return null;
    }
    const match = /^\/f\/([^/]+)$/.exec(url.pathname);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

export function timestampedArtifactDirectory(prefix: string): string {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  return path.resolve("migration-artifacts", `${prefix}-${timestamp}`);
}

export async function prepareDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
}

export function jsonLines(values: readonly object[]): string {
  return `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
}

export async function parseJsonLines<T>(
  filename: string,
  schema: z.ZodType<T>,
): Promise<T[]> {
  const contents = await readFile(filename, "utf8");
  return contents
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => schema.parse(JSON.parse(line)));
}
