import { Effect } from "effect";

import type { EditorSettingsDto } from "@forever-tee/contracts";
import {
  DesignRepository,
} from "./design-repository";
import type { AllowedSafetyScreeningDecision } from "./openai-safety-screening";

export const createDesign = () =>
  Effect.gen(function*() {
    const repository = yield* DesignRepository;
    return yield* repository.create();
  }).pipe(
    Effect.withSpan("design.create"),
  );

export const uploadDesignArtwork = (
  id: string,
  artwork: Uint8Array,
  contentType: string,
  settings?: EditorSettingsDto,
  screening?: AllowedSafetyScreeningDecision,
) =>
  Effect.gen(function*() {
    const repository = yield* DesignRepository;
    return yield* repository.uploadArtwork(
      {
        id,
        artwork,
        contentType,
        ...(screening ? { screening } : {}),
        ...(settings ? { settings } : {}),
      },
    );
  }).pipe(
    Effect.withSpan("design.uploadArtwork", {
      attributes: { id, contentType, byteSize: artwork.byteLength },
    }),
  );

export const getDesign = (id: string) =>
  Effect.gen(function*() {
    const repository = yield* DesignRepository;
    return yield* repository.find(id);
  }).pipe(Effect.withSpan("design.get", { attributes: { id } }));

export const getDesignArtwork = (id: string) =>
  Effect.gen(function*() {
    const repository = yield* DesignRepository;
    return yield* repository.artwork(id);
  }).pipe(Effect.withSpan("design.artwork", { attributes: { id } }));

export const getDesignArtworkPreview = (id: string) =>
  Effect.gen(function*() {
    const repository = yield* DesignRepository;
    return yield* repository.artworkPreview(id);
  }).pipe(Effect.withSpan("design.artworkPreview", { attributes: { id } }));

export const updateDesignSettings = (
  id: string,
  settings: EditorSettingsDto,
) =>
  Effect.gen(function*() {
    const repository = yield* DesignRepository;
    return yield* repository.updateSettings(id, settings);
  }).pipe(Effect.withSpan("design.updateSettings", { attributes: { id } }));
