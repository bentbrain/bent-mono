import { expect, test } from "bun:test";
import { parseXml } from "../src/activity";
import { loadVideo } from "../src/media";

test("XML metadata remains plain data, including decoded XML entities", () => {
  const activity = parseXml(
    '<g:gpx xmlns:g="http://www.topografix.com/GPX/1/1"><g:trk><g:name>&lt;img src=x onerror=alert(1)&gt; &amp; run</g:name><g:trkseg><g:trkpt lat="0" lon="0"/><g:trkpt lat="0.01" lon="0.01"/></g:trkseg></g:trk></g:gpx>',
    "activity.gpx",
  );
  expect(activity.name).toBe("<img src=x onerror=alert(1)> & run");
  expect(activity.points).toHaveLength(2);
});

test("malformed XML and excessive nesting are rejected", () => {
  expect(() => parseXml("<gpx><trk>", "bad.gpx")).toThrow("damaged");
  expect(() =>
    parseXml(
      `<gpx>${"<extension>".repeat(65)}${"</extension>".repeat(65)}</gpx>`,
      "deep.gpx",
    ),
  ).toThrow("64 levels");
});

test("media loading rejects nonlocal schemes before creating a DOM element", async () => {
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "https://example.invalid/video.mp4",
    "blob:javascript:alert(1)",
  ]) {
    await expect(loadVideo(url)).rejects.toThrow("local file URL");
  }
});
