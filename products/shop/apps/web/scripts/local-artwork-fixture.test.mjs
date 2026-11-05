import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("serves the browser artwork fixture in the same PNG format as public previews", () => {
  const result = JSON.parse(execFileSync(process.execPath, ["--import", "./e2e/local/preload.mjs", "--input-type=module", "-e", `
    import sharp from 'sharp';
    const response = await fetch('https://api.example.com/v1/designs/2c22bf7e-e698-4a0a-90c4-66c5549f1c45/artwork/preview?revision=fixture&access=revocable-v1');
    const bytes = Buffer.from(await response.arrayBuffer());
    const metadata = await sharp(bytes).metadata();
    console.log(JSON.stringify({ contentType: response.headers.get('content-type'), format: metadata.format, width: metadata.width, height: metadata.height }));
  `], { encoding: "utf8" }));
  expect(result).toEqual({ contentType: "image/png", format: "png", width: 900, height: 1200 });
});
