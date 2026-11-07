import { FileVideo } from "./file-video";
import type { CardMedia } from "./media";
import type { CardFrame } from "./video-frames";
import type { TrackPoint } from "./activity";
import { statistics } from "./activity";
import { depthLayers } from "./route-depth";

export interface CardOptions {
  title: string;
  sport: string;
  color: string;
  background: "transparent" | "ink" | "paper";
  mediaOverlay: number;
  format: "story" | "square";
  showStats: boolean;
  showTitle: boolean;
  pulse: boolean;
  motionTime: number;
  units: "km" | "mi";
  tilt: number;
  exaggeration: number;
  angle: number;
  duration: number;
}
export interface Vertex {
  x: number;
  y: number;
  z: number;
  segment: number;
  progress: number;
}
type Context = CanvasRenderingContext2D;

export function prepareRoute(points: TrackPoint[]): Vertex[] {
  if (!points.length) return [];
  const origin = points[0];
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);
  const raw: Vertex[] = [];
  let longitude = origin.lon;
  let previous = origin.lon;
  let travelled = 0;
  let elevation = points.find((p) => p.elevation !== undefined)?.elevation ?? 0;
  for (const point of points) {
    let delta = point.lon - previous;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    longitude += delta;
    previous = point.lon;
    elevation = point.elevation ?? elevation;
    const x = (longitude - origin.lon) * 111_195 * cosLat;
    const y = (point.lat - origin.lat) * 111_195;
    const last = raw.at(-1);
    if (last && last.segment === point.segment)
      travelled += Math.hypot(x - last.x, y - last.y, elevation - last.z);
    raw.push({
      x,
      y,
      z: elevation,
      segment: point.segment,
      progress: travelled,
    });
  }
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity,
    minZ = Infinity;
  for (const p of raw) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
    minZ = Math.min(minZ, p.z);
  }
  const scale = Math.max(maxX - minX, maxY - minY, 100);
  // Keep segment boundaries while limiting canvas work for long recordings.
  const stride = Math.max(1, Math.ceil(raw.length / 1800));
  return raw
    .filter(
      (p, i) =>
        i % stride === 0 ||
        i === raw.length - 1 ||
        p.segment !== raw[i - 1]?.segment ||
        p.segment !== raw[i + 1]?.segment,
    )
    .map((p) => ({
      x: (p.x - (minX + maxX) / 2) / scale,
      y: (p.y - (minY + maxY) / 2) / scale,
      z: (p.z - minZ) / scale,
      segment: p.segment,
      progress: travelled ? p.progress / travelled : 0,
    }));
}

function timeLabel(seconds: number | undefined) {
  if (seconds === undefined) return "—";
  const mins = Math.floor(seconds / 60);
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

export function cardStats(points: TrackPoint[], units: CardOptions["units"]) {
  const stats = statistics(points);
  return [
    {
      label: "DISTANCE",
      value: `${(stats.metres / (units === "mi" ? 1609.344 : 1000)).toFixed(2)}`,
      unit: units,
    },
    {
      label: "ELEVATION GAIN",
      value:
        stats.ascent === undefined
          ? "—"
          : Math.round(
              stats.ascent * (units === "mi" ? 3.28084 : 1),
            ).toLocaleString("en-US"),
      unit: units === "mi" ? "ft" : "m",
    },
    { label: "ELAPSED TIME", value: timeLabel(stats.seconds), unit: "" },
  ];
}

// Whole pulse cycles per orbit make GIF/MP4 loops seamless at every speed.
// Offsets use travelled distance before projection and depth sorting, so camera
// rotation and missing GPS segments cannot reverse the start-to-finish motion.
export function routePulseStops(
  start: number,
  end: number,
  seconds: number,
  duration: number,
) {
  const phase =
    ((seconds * Math.max(1, Math.round(duration / 6))) / duration) % 1;
  const radius = 0.09;
  const knots = [start, end];
  for (const wrap of [-1, 0, 1])
    for (const step of [-1, -0.5, 0, 0.5, 1]) {
      const progress = phase + wrap + step * radius;
      if (progress > start && progress < end) knots.push(progress);
    }
  return knots
    .sort((a, b) => a - b)
    .map((progress) => {
      const delta = Math.abs(progress - phase);
      const distance = Math.min(delta, 1 - delta);
      return {
        offset: (progress - start) / (end - start),
        alpha:
          distance < radius
            ? (0.4 * (1 + Math.cos((Math.PI * distance) / radius))) / 2
            : 0,
      };
    });
}

function drawStatIcon(
  ctx: Context,
  kind: number,
  x: number,
  y: number,
  size: number,
  color: string,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  if (kind === 0) {
    // Ruler with alternating measurement ticks.
    ctx.translate(12, 12);
    ctx.rotate(-Math.PI / 4);
    ctx.rect(-11, -4, 22, 8);
    for (let tick = 4; tick < 22; tick += 4) {
      ctx.moveTo(tick - 11, -4);
      ctx.lineTo(tick - 11, tick % 8 === 0 ? 1 : -1);
    }
  } else if (kind === 1) {
    ctx.moveTo(12, 22);
    ctx.lineTo(12, 3);
    ctx.moveTo(5, 10);
    ctx.lineTo(12, 3);
    ctx.lineTo(19, 10);
  } else {
    ctx.moveTo(9, 1);
    ctx.lineTo(15, 1);
    ctx.moveTo(12, 1);
    ctx.lineTo(12, 4);
    ctx.moveTo(18, 5);
    ctx.lineTo(20, 3);
    ctx.moveTo(21, 13);
    ctx.arc(12, 13, 9, 0, Math.PI * 2);
    ctx.moveTo(12, 8);
    ctx.lineTo(12, 13);
    ctx.lineTo(15, 15);
  }
  ctx.stroke();
  ctx.restore();
}

export function drawCard(
  ctx: Context,
  width: number,
  height: number,
  route: Vertex[],
  stats: ReturnType<typeof cardStats>,
  options: CardOptions,
  angle = options.angle,
  media?: CardFrame | CardMedia,
  motionTime = options.motionTime,
) {
  const photo = media instanceof FileVideo ? media.canvas : media;
  ctx.save();
  ctx.clearRect(0, 0, width, height);
  const transparent = options.background === "transparent" && !photo;
  const dark = options.background !== "paper";
  if (photo) {
    const sourceWidth =
      photo instanceof HTMLVideoElement
        ? photo.videoWidth
        : photo instanceof HTMLImageElement
          ? photo.naturalWidth
          : photo.width;
    const sourceHeight =
      photo instanceof HTMLVideoElement
        ? photo.videoHeight
        : photo instanceof HTMLImageElement
          ? photo.naturalHeight
          : photo.height;
    const scale = Math.max(width / sourceWidth, height / sourceHeight);
    ctx.drawImage(
      photo,
      (width - sourceWidth * scale) / 2,
      (height - sourceHeight * scale) / 2,
      sourceWidth * scale,
      sourceHeight * scale,
    );
    ctx.fillStyle = `rgba(0,0,0,${Math.min(100, Math.max(0, options.mediaOverlay)) / 100})`;
    ctx.fillRect(0, 0, width, height);
  } else if (!transparent) {
    ctx.fillStyle = dark ? "#000000" : "#ffffff";
    ctx.fillRect(0, 0, width, height);
  }
  const foreground = dark || photo ? "#ffffff" : "#111111";
  const muted = dark || photo ? "#bcc7d8" : "#555555";
  const pad = width * 0.085;
  ctx.textAlign = "left";
  ctx.fillStyle = options.color;
  ctx.font = `600 ${width * 0.022}px ui-monospace, monospace`;
  if (options.showTitle) {
    ctx.fillText(options.sport.slice(0, 30), pad, height * 0.1);
    ctx.fillStyle = foreground;
    ctx.font = `600 ${width * 0.061}px ui-monospace, monospace`;
    const title = options.title.trim() || "My activity";
    const words = title.split(/\s+/);
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      if (line && ctx.measureText(`${line} ${word}`).width > width - pad * 2) {
        lines.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
    lines
      .slice(0, 2)
      .forEach((text, i) =>
        ctx.fillText(
          text,
          pad,
          height * 0.15 + i * width * 0.075,
          width - pad * 2,
        ),
      );
  }
  const tilt = (options.tilt * Math.PI) / 180;
  const orbit = (angle * Math.PI) / 180;
  const cos = Math.cos(orbit),
    sin = Math.sin(orbit);
  const project = (p: Pick<Vertex, "x" | "y" | "z">) => {
    const x = p.x * cos - p.y * sin;
    const y = p.x * sin + p.y * cos;
    const z = p.z * options.exaggeration;
    return {
      x,
      y: -y * Math.sin(tilt) - z * Math.cos(tilt),
      depth: y * Math.cos(tilt) - z * Math.sin(tilt),
    };
  };
  const projected = route.map((p) => ({
    ...project(p),
    segment: p.segment,
    progress: p.progress,
  }));
  let extent = 0.75;
  // Fixed bounds across every orbit angle prevents breathing and clipping.
  for (const p of route)
    extent = Math.max(
      extent,
      Math.hypot(p.x, p.y) + Math.abs(p.z * options.exaggeration),
    );
  const plotHeight = height * (options.showStats ? 0.46 : 0.58);
  const scale = Math.min(width * 0.76, plotHeight) / (2 * extent);
  const centerX = width / 2,
    centerY = height * 0.49;
  const screen = (p: { x: number; y: number }) => ({
    x: centerX + p.x * scale,
    y: centerY + p.y * scale,
  });
  if (!transparent && !photo) {
    ctx.strokeStyle = dark ? "#ffffff0d" : "#14203912";
    ctx.lineWidth = width * 0.001;
    for (let i = -5; i <= 5; i++) {
      for (const axis of [0, 1]) {
        const a = project({
          x: axis ? -0.65 : i * 0.13,
          y: axis ? i * 0.13 : -0.65,
          z: 0,
        });
        const b = project({
          x: axis ? 0.65 : i * 0.13,
          y: axis ? i * 0.13 : 0.65,
          z: 0,
        });
        const sa = screen(a),
          sb = screen(b);
        ctx.beginPath();
        ctx.moveTo(sa.x, sa.y);
        ctx.lineTo(sb.x, sb.y);
        ctx.stroke();
      }
    }
  }
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = options.color;
  ctx.shadowBlur = 0;
  for (const edge of depthLayers(projected)) {
    if (edge.kind === "marker") {
      const s = screen(edge.point);
      ctx.beginPath();
      ctx.arc(s.x, s.y, width * 0.009, 0, Math.PI * 2);
      ctx.fillStyle = edge.start ? "#ffffff" : options.color;
      ctx.fill();
      ctx.strokeStyle = "#101622";
      ctx.lineWidth = width * 0.002;
      ctx.stroke();
      continue;
    }
    ctx.strokeStyle = options.color;
    ctx.lineWidth = width * 0.007;
    const a = screen(edge.a),
      b = screen(edge.b);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    if (
      options.pulse &&
      edge.b.progress > edge.a.progress &&
      (a.x !== b.x || a.y !== b.y)
    ) {
      const stops = routePulseStops(
        edge.a.progress,
        edge.b.progress,
        motionTime,
        options.duration,
      );
      if (stops.some((stop) => stop.alpha > 0)) {
        const gradient = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
        for (const stop of stops)
          gradient.addColorStop(stop.offset, `rgba(255,255,255,${stop.alpha})`);
        ctx.strokeStyle = gradient;
        ctx.stroke();
        ctx.strokeStyle = options.color;
      }
    }
  }
  if (options.showStats) {
    const y = height * 0.8;
    ctx.strokeStyle = dark || photo ? "#ffffff35" : "#14203935";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, y - width * 0.055);
    ctx.lineTo(width - pad, y - width * 0.055);
    ctx.stroke();
    stats.forEach((stat, i) => {
      const x = pad + (i * (width - pad * 2)) / 3;
      ctx.fillStyle = muted;
      ctx.font = `500 ${width * 0.023}px ui-monospace, monospace`;
      drawStatIcon(ctx, i, x, y - width * 0.024, width * 0.032, muted);
      ctx.fillStyle = foreground;
      ctx.font = `600 ${width * 0.045}px ui-monospace, monospace`;
      ctx.fillText(stat.value, x, y + width * 0.06);
      ctx.fillStyle = muted;
      ctx.font = `${width * 0.022}px ui-monospace, monospace`;
      ctx.fillText(stat.unit, x, y + width * 0.1);
    });
  }
  ctx.fillStyle = muted;
  ctx.font = `${width * 0.023}px ui-monospace, monospace`;
  ctx.restore();
}
