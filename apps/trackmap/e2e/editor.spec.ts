import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { FitBaseType, FitEncoder } from "fit-file-parser/encoder";

const gpx =
  '<gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Synthetic river run</name><trkseg><trkpt lat="0" lon="0"><ele>10</ele><time>2026-01-01T00:00:00Z</time></trkpt><trkpt lat="0.01" lon="0.01"><ele>30</ele><time>2026-01-01T00:10:00Z</time></trkpt><trkpt lat="0.02" lon="0.005"><ele>15</ele><time>2026-01-01T00:20:00Z</time></trkpt></trkseg></trk></gpx>';

function gifFrames(bytes: Buffer) {
  expect(bytes.subarray(0, 6).toString()).toBe("GIF89a");
  const frames: { transparent: boolean; disposal: number; delay: number }[] =
    [];
  let offset = 13 + (bytes[10] & 128 ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0);
  let control = { transparent: false, disposal: 0, delay: 0 };
  function skipBlocks() {
    while (bytes[offset] && offset < bytes.length) offset += bytes[offset] + 1;
    offset++;
  }
  while (offset < bytes.length && bytes[offset] !== 0x3b) {
    const type = bytes[offset++];
    if (type === 0x21) {
      const extension = bytes[offset++];
      if (extension === 0xf9)
        control = {
          transparent: Boolean(bytes[offset + 1] & 1),
          disposal: (bytes[offset + 1] >> 2) & 7,
          delay: bytes.readUInt16LE(offset + 2) * 10,
        };
      skipBlocks();
    } else if (type === 0x2c) {
      const packed = bytes[offset + 8];
      offset += 9;
      if (packed & 128) offset += 3 * 2 ** ((packed & 7) + 1);
      offset++;
      skipBlocks();
      frames.push(control);
    } else throw new Error(`Unexpected GIF block ${type}`);
  }
  expect(bytes[offset]).toBe(0x3b);
  return frames;
}

test("imports, customizes and exports genuinely transparent PNGs and animated GIFs", async ({
  page,
}, info) => {
  const errors: string[] = [];
  const outbound: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (
      !request.url().startsWith("http://127.0.0.1:4175") &&
      !request.url().startsWith("data:") &&
      !request.url().startsWith("blob:")
    )
      outbound.push(request.url());
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your effort. Another dimension." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Play rotation" }),
  ).toBeVisible();
  await expect(page.locator("canvas")).toHaveAttribute("height", "1280");
  await page.screenshot({
    path: info.outputPath("editor.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByLabel("Activity file", { exact: true }).setInputFiles({
    name: "run.gpx",
    mimeType: "application/gpx+xml",
    buffer: Buffer.from(gpx),
  });
  await expect(page.getByLabel("Activity title", { exact: true })).toHaveValue(
    "Synthetic river run",
  );
  await page
    .getByLabel("Activity title", { exact: true })
    .fill("That was worth it");
  await page.getByRole("button", { name: "▧ Clear", exact: true }).click();
  await page.getByLabel("Loop length").selectOption("4");
  const pngDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save PNG" }).click();
  const pngPath = await (await pngDownload).path();
  if (!pngPath) throw new Error("Missing PNG download");
  const png = await readFile(pngPath);
  expect(png.readUInt32BE(16)).toBe(1080);
  expect(png.readUInt32BE(20)).toBe(1920);
  const pixels = await page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No canvas");
    ctx.drawImage(img, 0, 0);
    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let clear = 0,
      opaque = 0;
    for (let i = 3; i < rgba.length; i += 4) {
      if (!rgba[i]) clear++;
      if (rgba[i] === 255) opaque++;
    }
    return { clear, opaque };
  }, png.toString("base64"));
  expect(pixels.clear).toBeGreaterThan(1_500_000);
  expect(pixels.opaque).toBeGreaterThan(1000);
  const gifDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export animated GIF" }).click();
  const gifPath = await (await gifDownload).path();
  if (!gifPath) throw new Error("Missing GIF download");
  const gif = await readFile(gifPath);
  expect(gif.readUInt16LE(6)).toBe(540);
  expect(gif.readUInt16LE(8)).toBe(960);
  const frames = gifFrames(gif);
  expect(frames).toHaveLength(48);
  expect(
    frames.every((frame) => frame.transparent && frame.disposal === 2),
  ).toBe(true);
  expect(frames.reduce((total, frame) => total + frame.delay, 0)).toBe(4000);
  await expect(page.getByRole("status")).toContainText("GIF ready");
  await page.getByLabel("Frame", { exact: true }).selectOption("square");
  await expect(page.locator("canvas")).toHaveAttribute("height", "720");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: info.outputPath("transparent-square.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
  expect(outbound).toEqual([]);
});

test("imports TCX, GeoJSON and FIT; malformed input keeps the previous activity", async ({
  page,
}) => {
  await page.goto("/");
  const tcx =
    '<TrainingCenterDatabase><Activities><Activity Sport="Biking"><Lap><Track><Trackpoint><Position><LatitudeDegrees>0</LatitudeDegrees><LongitudeDegrees>0</LongitudeDegrees></Position></Trackpoint><Trackpoint><Position><LatitudeDegrees>0.01</LatitudeDegrees><LongitudeDegrees>0.01</LongitudeDegrees></Position></Trackpoint></Track></Lap></Activity></Activities></TrainingCenterDatabase>';
  await page.getByLabel("Activity file", { exact: true }).setInputFiles({
    name: "ride.tcx",
    mimeType: "text/xml",
    buffer: Buffer.from(tcx),
  });
  await expect(page.getByLabel("Activity", { exact: true })).toHaveValue(
    "Biking",
  );
  await page.getByLabel("Activity file", { exact: true }).setInputFiles({
    name: "route.geojson",
    mimeType: "application/json",
    buffer: Buffer.from(
      '{"type":"LineString","coordinates":[[0,0],[0.01,0.01]]}',
    ),
  });
  await expect(page.getByLabel("Activity title", { exact: true })).toHaveValue(
    "route",
  );
  const encoder = new FitEncoder();
  for (const position of [0, 119305])
    encoder.writeMessage(20, [
      { number: 0, size: 4, baseType: FitBaseType.Sint32, value: position },
      { number: 1, size: 4, baseType: FitBaseType.Sint32, value: position },
    ]);
  await page.getByLabel("Activity file", { exact: true }).setInputFiles({
    name: "watch.fit",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(encoder.close()),
  });
  await expect(page.getByLabel("Activity title", { exact: true })).toHaveValue(
    "watch",
  );
  await page.getByLabel("Activity file", { exact: true }).setInputFiles({
    name: "bad.gpx",
    mimeType: "text/xml",
    buffer: Buffer.from("<gpx><trk>"),
  });
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("Activity title", { exact: true })).toHaveValue(
    "watch",
  );
  await page.getByText("Privacy & route details", { exact: true }).click();
  await page.getByLabel("Hide each end").fill("2000");
  await expect(
    page.getByRole("button", { name: "Export animated GIF" }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save PNG" })).toBeDisabled();
});

test("can cancel an export and make another", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Export animated GIF" }).click();
  await page.getByRole("button", { name: "Cancel export" }).click();
  await expect(page.getByRole("button", { name: "Save PNG" })).toBeEnabled();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save PNG" }).click();
  await download;
});

test("composites a local photo and removes it when Clear is selected", async ({
  page,
}) => {
  await page.goto("/");
  const photo = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 100;
    canvas.height = 100;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No canvas");
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 100, 100);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.getByLabel("Background photo", { exact: true }).setInputFiles({
    name: "synthetic.png",
    mimeType: "image/png",
    buffer: Buffer.from(photo, "base64"),
  });
  await expect(
    page.getByRole("button", { name: "Remove", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.locator("canvas").evaluate((element) => {
        if (!(element instanceof HTMLCanvasElement))
          throw new Error("No canvas");
        return element.getContext("2d")?.getImageData(0, 0, 1, 1).data[0];
      }),
    )
    .toBeGreaterThan(100);
  await page.getByRole("button", { name: "▧ Clear", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Remove", exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      page.locator("canvas").evaluate((element) => {
        if (!(element instanceof HTMLCanvasElement))
          throw new Error("No canvas");
        return element.getContext("2d")?.getImageData(0, 0, 1, 1).data[3];
      }),
    )
    .toBe(0);
});

test("animates and restores the starting view after pausing", async ({
  page,
}) => {
  await page.goto("/");
  const image = () =>
    page.locator("canvas").evaluate((element) => {
      if (!(element instanceof HTMLCanvasElement)) throw new Error("No canvas");
      return element.toDataURL();
    });
  await expect
    .poll(() =>
      page.locator("canvas").evaluate((element) => {
        if (!(element instanceof HTMLCanvasElement))
          throw new Error("No canvas");
        return element.getContext("2d")?.getImageData(0, 0, 1, 1).data[3];
      }),
    )
    .toBe(255);
  const initial = await image();
  await page
    .getByRole("button", { name: "Play rotation", exact: true })
    .click();
  await expect.poll(async () => (await image()) === initial).toBe(false);
  await page
    .getByRole("button", { name: "Pause rotation", exact: true })
    .click();
  await expect.poll(async () => (await image()) === initial).toBe(false);
  await page.getByRole("button", { name: "Reset view" }).click();
  await expect.poll(async () => (await image()) === initial).toBe(true);
});
