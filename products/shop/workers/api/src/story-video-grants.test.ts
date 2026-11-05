import { describe, expect, it } from "vitest";
import { createStoryVideoGrant, isStoryVideoJobId, verifyStoryVideoGrant } from "./story-video-grants";

const secret = "test-only-".repeat(8);
const jobId = "11111111-1111-1111-1111-111111111111";
describe("scoped video grants", () => {
  it("authenticates exactly one job and attempt for three minutes", async () => {
    const token = await createStoryVideoGrant(secret, jobId, 2, 1000);
    expect(await verifyStoryVideoGrant(secret, token, jobId, 1001)).toEqual({ jobId, attempt: 2, expiresAt: 181000 });
    expect(await verifyStoryVideoGrant(secret, token, jobId, 181000)).toBeUndefined();
    expect(await verifyStoryVideoGrant(secret, token, jobId.replaceAll("1", "2"), 1001)).toBeUndefined();
    expect(await verifyStoryVideoGrant(secret, `${token}x`, jobId, 1001)).toBeUndefined();
    expect(await verifyStoryVideoGrant("another-secret".repeat(4), token, jobId, 1001)).toBeUndefined();
  });
  it("rejects malformed, oversized and unsafe grants", async () => {
    for (const token of ["", "a.b", "..", "x".repeat(2048)]) expect(await verifyStoryVideoGrant(secret, token, jobId)).toBeUndefined();
    await expect(createStoryVideoGrant(secret, jobId, 4)).rejects.toThrow();
    await expect(createStoryVideoGrant("short", jobId, 1)).rejects.toThrow();
  });
  it("accepts only the historical renderer suffix sequence added by migrations", async () => {
    for (const id of [jobId, `${jobId}-v5`, `${jobId}-v5-v6`, `${jobId}-v5-v6-v7`]) {
      expect(isStoryVideoJobId(id)).toBe(true);
      const token = await createStoryVideoGrant(secret, id, 3, 1000);
      expect(await verifyStoryVideoGrant(secret, token, id, 1001)).toEqual({ jobId: id, attempt: 3, expiresAt: 181000 });
    }
    for (const id of [`${jobId}-v7`, `${jobId}-v5-v7`, `${jobId}-v5-v6-v7-v8`, `prefix-${jobId}`]) {
      expect(isStoryVideoJobId(id)).toBe(false);
      await expect(createStoryVideoGrant(secret, id, 3, 1000)).rejects.toThrow();
    }
  });
});
