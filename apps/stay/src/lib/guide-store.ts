import "server-only";
import { randomUUID } from "node:crypto";
import { BlobPreconditionFailedError, get, put } from "@vercel/blob";
import { articles, chatKnowledge, home } from "@/content/guide";
import { getPrivateHomeControlsUrl } from "./home-controls-config";
import {
  normalizeGuideLinks,
  isGuideFixtureEnvironment,
} from "./guide-content-policy";
import { upgradeGuideDocument, upgradeGuideState } from "@/lib/guide-migration";
import {
  changeGuideState,
  guideDocumentSchema,
  guideStateSchema,
  type CmsAction,
  type CmsSnapshot,
  type GuideDocument,
} from "@/lib/guide-cms-types";

const pathname = "guide/content.json";
export class GuideConflictError extends Error {}
function editingAvailable() {
  return (
    !isGuideFixtureEnvironment(process.env) &&
    Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN)
  );
}
function initialSnapshot(): CmsSnapshot {
  const document = guideDocumentSchema.parse(
    upgradeGuideDocument(
      guideDocumentSchema.parse({ home, articles, chatKnowledge }),
    ),
  );
  return {
    state: {
      version: 1,
      revision: "source",
      published: document,
      draft: document,
      savedAt: null,
      publishedAt: null,
    },
    etag: null,
    canSave: editingAvailable(),
  };
}
export async function getCmsSnapshot(): Promise<CmsSnapshot> {
  if (isGuideFixtureEnvironment(process.env)) return initialSnapshot();
  if (!editingAvailable())
    throw new Error("Private guide storage is not configured.");
  const result = await get(pathname, {
    access: "private",
    useCache: false,
    // Compressed responses use a weak HTTP ETag, which cannot guard a write.
    headers: { "Accept-Encoding": "identity" },
  });
  if (!result)
    throw new Error("Private guide content has not been initialized.");
  if (result.statusCode !== 200)
    throw new Error("Guide content could not be read.");
  const json: unknown = await new Response(result.stream).json();
  return {
    state: guideStateSchema.parse(
      upgradeGuideState(
        guideStateSchema.parse(
          normalizeGuideLinks(json, await getPrivateHomeControlsUrl()),
        ),
      ),
    ),
    etag: result.blob.etag,
    canSave: true,
  };
}
export async function getGuideDocument(draft = false): Promise<GuideDocument> {
  const { state } = await getCmsSnapshot();
  return draft ? state.draft : state.published;
}
export async function saveGuideDocument(
  document: GuideDocument,
  action: CmsAction,
  etag: string | null,
): Promise<CmsSnapshot> {
  if (!editingAvailable()) throw new Error("Editing is unavailable.");
  const current = await getCmsSnapshot();
  if (current.etag !== etag) throw new GuideConflictError();
  const state = changeGuideState(
    current.state,
    document,
    action,
    randomUUID(),
    new Date().toISOString(),
  );
  try {
    const blob = await put(pathname, JSON.stringify(state), {
      access: "private",
      contentType: "application/json",
      addRandomSuffix: false,
      ...(etag ? { ifMatch: etag } : { allowOverwrite: false }),
    });
    return { state, etag: blob.etag, canSave: true };
  } catch (error) {
    if (error instanceof BlobPreconditionFailedError)
      throw new GuideConflictError();
    if (!etag && (await getCmsSnapshot()).etag !== null)
      throw new GuideConflictError();
    throw error;
  }
}
