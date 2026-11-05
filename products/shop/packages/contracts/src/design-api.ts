import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";

import {
  BackgroundRemovalQuality,
  CreateDesignResponseSchema,
  DependencyUnavailable,
  DesignId,
  DesignNotFound,
  DesignSchema,
  EditorSettingsSchema,
  InvalidRequest,
  RateLimitExceeded,
  UnexpectedServerError,
  UpdateDesignResponseSchema,
  UploadDesignArtworkResponseSchema,
} from "./design";

const DesignPath = Schema.Struct({ id: DesignId });
const ImageHeaders = Schema.Struct({
  "content-type": Schema.String,
  "x-background-removal-quality": Schema.optional(BackgroundRemovalQuality),
});
const UploadDesignArtworkHeaders = Schema.Struct({
  "content-type": Schema.String,
  "x-design-settings": Schema.parseJson(EditorSettingsSchema),
});
const ProcessDesignArtworkHeaders = Schema.Struct({
  "content-type": Schema.String,
});

export const DesignsGroup = HttpApiGroup.make("designs")
  .add(
    HttpApiEndpoint.post("removeBackground", "/background-removal")
      .setHeaders(ImageHeaders)
      .setPayload(HttpApiSchema.Uint8Array())
      .addSuccess(HttpApiSchema.Uint8Array({ contentType: "image/png" })),
  )
  .add(
    HttpApiEndpoint.post("createDesign", "/designs")
      .addSuccess(CreateDesignResponseSchema, { status: 201 }),
  )
  .add(
    HttpApiEndpoint.put("uploadDesignArtwork", "/designs/:id/artwork")
      .setPath(DesignPath)
      .setHeaders(UploadDesignArtworkHeaders)
      .setPayload(HttpApiSchema.Uint8Array())
      .addSuccess(UploadDesignArtworkResponseSchema),
  )
  .add(
    HttpApiEndpoint.put(
      "processDesignArtwork",
      "/designs/:id/artwork/background-removal",
    )
      .setPath(DesignPath)
      .setHeaders(ProcessDesignArtworkHeaders)
      .setPayload(HttpApiSchema.Uint8Array())
      .addSuccess(UploadDesignArtworkResponseSchema),
  )
  .add(
    HttpApiEndpoint.get("getDesign", "/designs/:id")
      .setPath(DesignPath)
      .addSuccess(DesignSchema),
  )
  .add(
    HttpApiEndpoint.patch("updateDesign", "/designs/:id")
      .setPath(DesignPath)
      .setPayload(EditorSettingsSchema)
      .addSuccess(UpdateDesignResponseSchema),
  )
  .add(
    HttpApiEndpoint.get("getArtwork", "/designs/:id/artwork")
      .setPath(DesignPath)
      .addSuccess(HttpApiSchema.Uint8Array({ contentType: "image/png" })),
  )
  .add(
    HttpApiEndpoint.get("getArtworkPreview", "/designs/:id/artwork/preview")
      .setPath(DesignPath)
      .addSuccess(HttpApiSchema.Uint8Array({ contentType: "image/webp" })),
  )
  .addError(InvalidRequest, { status: 400 })
  .addError(DesignNotFound, { status: 404 })
  .addError(RateLimitExceeded, { status: 429 })
  .addError(DependencyUnavailable, { status: 503 })
  .addError(UnexpectedServerError, { status: 500 });
