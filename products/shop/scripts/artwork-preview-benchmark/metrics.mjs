import sharp from "sharp";

// Compare at a common display size. This measures disagreement, not whether
// either segmentation is correct. Hair, holes and fine edges still need review.
export async function comparePreviews(early, final) {
  const metadata = await sharp(final).metadata();
  const height = 900;
  const width = Math.round(metadata.width * height / metadata.height);
  const decode = bytes => sharp(bytes).resize(width, height, { fit: "fill" })
    .ensureAlpha().raw().toBuffer();
  const [left, right] = await Promise.all([decode(early), decode(final)]);
  let union = 0, intersection = 0, changed = 0, alphaError = 0;
  let visibleColourError = 0, visibleChannels = 0;
  for (let index = 0; index < left.length; index += 4) {
    const a = left[index + 3], b = right[index + 3];
    union += a > 127 || b > 127 ? 1 : 0;
    intersection += a > 127 && b > 127 ? 1 : 0;
    changed += Math.abs(a - b) > 32 ? 1 : 0;
    alphaError += Math.abs(a - b);
    if (a > 240 && b > 240) {
      for (let channel = 0; channel < 3; channel++) {
        visibleColourError += Math.abs(left[index + channel] - right[index + channel]);
        visibleChannels++;
      }
    }
  }
  return {
    width, height,
    maskIntersectionOverUnion: union ? intersection / union : null,
    changedAlphaFraction: changed / (width * height),
    meanAlphaError: alphaError / (width * height),
    meanVisibleColourError: visibleChannels ? visibleColourError / visibleChannels : null,
  };
}

export async function comparePrintSources(baseline, candidate) {
  const decode = bytes => sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const [left, right] = await Promise.all([decode(baseline), decode(candidate)]);
  const sameDimensions = left.info.width === right.info.width && left.info.height === right.info.height;
  return {
    width: right.info.width, height: right.info.height,
    sameDimensions,
    identicalBytes: Buffer.from(baseline).equals(Buffer.from(candidate)),
    identicalPixels: sameDimensions && left.data.equals(right.data),
  };
}

export function assertEarlyPreview(events) {
  const early = events.find(event => event.name === "early-preview");
  const final = events.find(event => event.name === "print-ready");
  if (!early || !final || early.elapsedMs >= final.elapsedMs) {
    throw new Error("Canvas preview was not delivered before the full-resolution print source.");
  }
  return { earlyMs: early.elapsedMs, printMs: final.elapsedMs, headStartMs: final.elapsedMs - early.elapsedMs };
}

export async function benchmarkLossless(input, repeats = 3) {
  const reference = await sharp(input).rotate().toColourspace("srgb").ensureAlpha()
    .raw().toBuffer({ resolveWithObject: true });
  const cases = [
    ...[0, 1, 4, 6].map(effort => ({ format: "webp", options: { lossless: true, effort, exact: true } })),
    ...[0, 1, 6].map(compressionLevel => ({ format: "png", options: { compressionLevel, palette: false } })),
  ];
  const results = [];
  for (const candidate of cases) {
    const durationMs = [];
    let output;
    for (let repeat = 0; repeat < repeats; repeat++) {
      const start = performance.now();
      output = await sharp(reference.data, { raw: reference.info })
        .toFormat(candidate.format, candidate.options).toBuffer();
      durationMs.push(Math.round(performance.now() - start));
    }
    const decoded = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const exact = decoded.info.width === reference.info.width && decoded.info.height === reference.info.height &&
      decoded.data.equals(reference.data);
    if (!exact) throw new Error(`Lossless ${candidate.format} changed decoded pixels.`);
    results.push({ ...candidate, durationMs, bytes: output.length, exact,
      withinPreparedLimit: output.length <= 19_000_000 });
  }
  return results;
}
