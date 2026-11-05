import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { fileURLToPath } from "node:url";

const cutouts = [
  "tee-black-cutout-v1.png",
  "tee-white-cutout-v1.png",
] as const;

describe("story video shirt cutouts", () => {
  it.each(cutouts)("keeps the garment and removes only its exterior in %s", async (file) => {
    const path = fileURLToPath(
      new URL(`../../public/mockups/${file}`, import.meta.url),
    );
    const image = sharp(path);
    const metadata = await image.metadata();
    const { data, info } = await image.ensureAlpha().raw().toBuffer({
      resolveWithObject: true,
    });
    const alphaAt = (x: number, y: number) =>
      data[(y * info.width + x) * info.channels + 3];

    expect(metadata.hasAlpha).toBe(true);
    expect(alphaAt(0, 0)).toBe(0);
    expect(alphaAt(750, 750)).toBe(255);
  });
});
