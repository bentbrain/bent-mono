import type { CardMedia } from "./media";
import type { TrackPoint } from "./activity";
import { statistics } from "./activity";

export interface CardOptions {
  title: string;
  sport: string;
  color: string;
  background: "transparent" | "ink" | "paper";
  format: "story" | "square";
  showStats: boolean;
  showTitle: boolean;
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
}
type Context = CanvasRenderingContext2D;

export function prepareRoute(points: TrackPoint[]): Vertex[] {
  if (!points.length) return [];
  const origin = points[0];
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);
  const raw: Vertex[] = [];
  let longitude = origin.lon;
  let previous = origin.lon;
  let elevation = points.find((p) => p.elevation !== undefined)?.elevation ?? 0;
  for (const point of points) {
    let delta = point.lon - previous;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    longitude += delta;
    previous = point.lon;
    elevation = point.elevation ?? elevation;
    raw.push({
      x: (longitude - origin.lon) * 111_195 * cosLat,
      y: (point.lat - origin.lat) * 111_195,
      z: elevation,
      segment: point.segment,
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

export function drawCard(
  ctx: Context,
  width: number,
  height: number,
  route: Vertex[],
  stats: ReturnType<typeof cardStats>,
  options: CardOptions,
  angle = options.angle,
  photo?: CardMedia,
) {
  ctx.save();
  ctx.clearRect(0, 0, width, height);
  const transparent = options.background === "transparent" && !photo;
  const dark = options.background !== "paper";
  if (photo) {
    const sourceWidth =
      photo instanceof HTMLVideoElement ? photo.videoWidth : photo.naturalWidth;
    const sourceHeight =
      photo instanceof HTMLVideoElement
        ? photo.videoHeight
        : photo.naturalHeight;
    const scale = Math.max(width / sourceWidth, height / sourceHeight);
    ctx.drawImage(
      photo,
      (width - sourceWidth * scale) / 2,
      (height - sourceHeight * scale) / 2,
      sourceWidth * scale,
      sourceHeight * scale,
    );
    ctx.fillStyle = "#00000065";
    ctx.fillRect(0, 0, width, height);
  } else if (!transparent) {
    ctx.fillStyle = dark ? "#101622" : "#f3f1e9";
    ctx.fillRect(0, 0, width, height);
    const gradient = ctx.createRadialGradient(
      width * 0.5,
      height * 0.4,
      0,
      width * 0.5,
      height * 0.4,
      width * 0.8,
    );
    gradient.addColorStop(0, dark ? "#1b2c43" : "#ffffff");
    gradient.addColorStop(1, dark ? "#101622" : "#e9e5db");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  }
  const foreground = dark || photo ? "#ffffff" : "#142039";
  const muted = dark || photo ? "#bcc7d8" : "#52617a";
  const pad = width * 0.085;
  ctx.textAlign = "left";
  ctx.fillStyle = options.color;
  ctx.font = `600 ${width * 0.022}px ui-monospace, monospace`;
  ctx.fillText(
    "TRACKMAP / " + options.sport.toUpperCase().slice(0, 30),
    pad,
    height * 0.1,
  );
  if (options.showTitle) {
    ctx.fillStyle = foreground;
    ctx.font = `600 ${width * 0.061}px system-ui, sans-serif`;
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
  const project = (p: Vertex, floor = false) => {
    const x = p.x * cos - p.y * sin;
    const y = p.x * sin + p.y * cos;
    const z = floor ? 0 : p.z * options.exaggeration;
    return {
      x,
      y: -y * Math.sin(tilt) - z * Math.cos(tilt),
      depth: y * Math.cos(tilt) - z * Math.sin(tilt),
    };
  };
  const projected = route.map((p) => ({ ...project(p), segment: p.segment }));
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
          segment: 0,
        });
        const b = project({
          x: axis ? 0.65 : i * 0.13,
          y: axis ? i * 0.13 : 0.65,
          z: 0,
          segment: 0,
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
  // Elevation stems describe the real profile without inventing terrain.
  ctx.strokeStyle = options.color + "35";
  ctx.lineWidth = Math.max(1, width * 0.0015);
  for (
    let i = 0;
    i < route.length;
    i += Math.max(1, Math.floor(route.length / 65))
  ) {
    const top = screen(projected[i]);
    const bottom = screen(project(route[i], true));
    ctx.beginPath();
    ctx.moveTo(bottom.x, bottom.y);
    ctx.lineTo(top.x, top.y);
    ctx.stroke();
  }
  const edges = projected
    .slice(1)
    .map((p, i) => ({ a: projected[i], b: p }))
    .filter((e) => e.a.segment === e.b.segment)
    .sort((a, b) => b.a.depth + b.b.depth - a.a.depth - a.b.depth);
  ctx.shadowColor = options.color;
  ctx.shadowBlur = transparent ? 0 : width * 0.005;
  ctx.strokeStyle = options.color;
  ctx.lineWidth = width * 0.007;
  for (const edge of edges) {
    const a = screen(edge.a),
      b = screen(edge.b);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
  for (const [i, p] of [projected[0], projected.at(-1)].entries()) {
    if (!p) continue;
    const s = screen(p);
    ctx.beginPath();
    ctx.arc(s.x, s.y, width * 0.009, 0, Math.PI * 2);
    ctx.fillStyle = i === 0 ? "#ffffff" : options.color;
    ctx.fill();
    ctx.strokeStyle = "#101622";
    ctx.lineWidth = width * 0.002;
    ctx.stroke();
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
      ctx.fillText(stat.label, x, y);
      ctx.fillStyle = foreground;
      ctx.font = `600 ${width * 0.045}px system-ui, sans-serif`;
      ctx.fillText(stat.value, x, y + width * 0.06);
      ctx.fillStyle = muted;
      ctx.font = `${width * 0.022}px ui-monospace, monospace`;
      ctx.fillText(stat.unit, x, y + width * 0.1);
    });
  }
  ctx.fillStyle = muted;
  ctx.font = `${width * 0.023}px ui-monospace, monospace`;
  ctx.fillText("MADE OF MILES. MADE BY YOU.", pad, height * 0.945);
  ctx.restore();
}
