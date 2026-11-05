import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { convexTest } from "convex-test";

import schema from "../convex/schema";
import { api } from "../convex/_generated/api.js";

const modules = {
  "./_generated/server.js": () => import("../convex/_generated/server.js"),
  "./collages.ts": () => import("../convex/collages"),
};

function backend() {
  return convexTest(schema, modules);
}

await describe("collage access control", async () => {
  await it("denies anonymous callers and signed identities without an admin role", async () => {
    const app = backend();
    await assert.rejects(app.query(api.collages.getAllForAdmin, { limit: 30, offset: 0 }), /Unauthenticated/);
    for (const identity of [
      { subject: "user", role: "user" },
      { subject: "user" },
      { subject: "user", role: { role: "admin" } },
    ]) {
      await assert.rejects(app.withIdentity(identity).query(api.collages.getAllForAdmin, { limit: 30, offset: 0 }), /Forbidden/);
    }
  });

  await it("allows signed admin roles and preserves private owner and public gallery access", async () => {
    const app = backend();
    const owner = app.withIdentity({ subject: "owner", role: "user" });
    const privateCollage = await owner.mutation(api.collages.create, {
      collageJson: "{}", imageUrl: "https://example.invalid/private.png", nsfw: false,
    });
    const publicCollage = await owner.mutation(api.collages.create, {
      collageJson: "{}", imageUrl: "https://example.invalid/public.png", nsfw: false,
    });
    await owner.mutation(api.collages.update, { legacyId: publicCollage.id, public: true });

    const admin = app.withIdentity({ subject: "admin", role: "admin" });
    const all = await admin.query(api.collages.getAllForAdmin, { limit: 30, offset: 0 });
    assert.equal(all.length, 2);
    assert.ok(all.some((collage) => collage.legacyId === privateCollage.id));
    assert.ok(await owner.query(api.collages.getByLegacyId, { legacyId: privateCollage.id }));
    assert.equal(await app.withIdentity({ subject: "other" }).query(api.collages.getByLegacyId, { legacyId: privateCollage.id }), null);

    const publicGallery = await app.query(api.collages.getByUserOffset, { userId: "owner", limit: 30, offset: 0 });
    assert.deepEqual(publicGallery.map((collage) => collage.legacyId), [publicCollage.id]);
    const ownerGallery = await owner.query(api.collages.getByUserOffset, { userId: "owner", limit: 30, offset: 0 });
    assert.equal(ownerGallery.length, 2);
  });
});
