import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const input = JSON.parse(await readFile(process.argv[2], "utf8"));
const output = resolve(process.argv[3]);
assert.match(input.endpoint, /^https:\/\/forever-tee-story-video-benchmark[\w-]*\.socialqueue\.workers\.dev$/);
assert.ok(process.env.REMOTE_BENCHMARK_TOKEN);
await mkdir(output, { recursive: true });
function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  return result;
}
const files = new Map();
const report = { media: [], comparisons: [] };
for (const item of input.videos) {
  assert.match(item.name, /^[a-z0-9-]+$/);
  const response = await fetch(`${input.endpoint}/render`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.REMOTE_BENCHMARK_TOKEN}`, "x-story-video-key": item.key },
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-story-video-cache"), "hit", "Inspection must never trigger a render.");
  const path = resolve(output, `${item.name}.mp4`);
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
  files.set(item.name, path);
  const probe = JSON.parse(run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path]).stdout);
  assert.equal(probe.streams.length, 1);
  const stream = probe.streams[0];
  assert.equal(stream.codec_name, "h264");
  assert.equal(stream.pix_fmt, "yuv420p");
  assert.equal(stream.width, 1080);
  assert.equal(stream.height, 1920);
  assert.equal(stream.r_frame_rate, "30/1");
  assert.equal(Number(stream.nb_frames), 240);
  assert.equal(Number(probe.format.duration), 8);
  report.media.push({ name: item.name, bytes: Number(probe.format.size), duration: Number(probe.format.duration), frames: Number(stream.nb_frames) });
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-threads", "2", "-i", path,
    "-vf", "select='eq(n,0)+eq(n,15)+eq(n,30)+eq(n,60)+eq(n,90)+eq(n,105)+eq(n,120)+eq(n,135)',scale=270:480,tile=4x2",
    "-frames:v", "1", "-y", resolve(output, `${item.name}-timeline.png`)]);
  for (const [frame, label] of [[96, "cursor-on"], [111, "cursor-off"]]) {
    run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-threads", "2", "-ss", String(frame / 30), "-i", path,
      "-frames:v", "1", "-y", resolve(output, `${item.name}-${label}.png`)]);
  }
}
for (const pair of input.comparisons) {
  const reference = files.get(pair.reference);
  const candidate = files.get(pair.candidate);
  assert.ok(reference && candidate);
  const stats = resolve(output, `${pair.candidate}-ssim.log`);
  const result = run("ffmpeg", ["-hide_banner", "-threads", "2", "-i", reference, "-threads", "2", "-i", candidate,
    "-filter_complex", `[0:v][1:v]ssim=stats_file=${stats}`, "-an", "-f", "null", "-"]);
  const average = Number(result.stderr.match(/All:([\d.]+)/)?.[1]);
  const frames = (await readFile(stats, "utf8")).trim().split("\n").map(line => Number(line.match(/All:([\d.]+)/)?.[1]));
  assert.equal(frames.length, 240);
  assert.ok(frames.every(Number.isFinite));
  const minimum = Math.min(...frames);
  const zoomAverage = frames.slice(0, 91).reduce((sum, value) => sum + value, 0) / 91;
  const passed = average >= 0.995 && minimum >= 0.96;
  report.comparisons.push({ ...pair, average, minimum, zoomAverage, passed });
  // Report visual differences without suppressing the downloadable evidence.
  console.info(JSON.stringify(report.comparisons.at(-1)));
}
await writeFile(resolve(output, "inspection.json"), `${JSON.stringify(report, null, 2)}\n`);
assert.ok(report.comparisons.every(pair => pair.passed), "A candidate failed the image-equivalence gate. Inspect the saved frames.");
