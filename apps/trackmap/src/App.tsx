import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@bent/ui/button";
import { Field, Input, Select } from "@bent/ui/field";
import { designTokens } from "@bent/design-tokens";
import type { Activity } from "./activity";
import { demoActivity, MAX_FILE_BYTES, parseFile, trimRoute } from "./activity";
import type { CardOptions } from "./render";
import { cardStats, drawCard, prepareRoute } from "./render";
import { download, exportGif, exportPng, exportVideo } from "./export";

import { FileVideo } from "./file-video";
import type { CardMedia } from "./media";
import { loadVideoFile, releaseMedia } from "./media";

const initialOptions: CardOptions = {
  title: "Sample activity",
  sport: "Run",
  color: designTokens.accentLight,
  background: "paper",
  format: "story",
  showStats: true,
  showTitle: true,
  pulse: true,
  motionTime: 0,
  units: "km",
  tilt: 38,
  exaggeration: 3,
  angle: 25,
  duration: 30,
};
const colors = [
  designTokens.accentLight,
  "#ffffff",
  "#111111",
  "#ff6633",
  "#53b89c",
];

export default function App() {
  const [activity, setActivity] = useState<Activity>(demoActivity);
  const [options, setOptions] = useState(initialOptions);
  const [playing, setPlaying] = useState(
    () => !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [trim, setTrim] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [photo, setPhoto] = useState<CardMedia>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const importVersion = useRef(0);
  const photoVersion = useRef(0);
  const angle = useRef(options.angle);
  const motionTime = useRef(options.motionTime);
  const points = useMemo(
    () => trimRoute(activity.points, trim),
    [activity.points, trim],
  );
  const route = useMemo(() => prepareRoute(points), [points]);
  const stats = useMemo(
    () => cardStats(points, options.units),
    [points, options.units],
  );
  const exportable = points.length >= 2;

  function update<K extends keyof CardOptions>(key: K, value: CardOptions[K]) {
    setOptions((previous) => ({ ...previous, [key]: value }));
  }

  useEffect(() => {
    angle.current = options.angle;
  }, [options.angle]);

  useEffect(() => {
    const element = canvas.current;
    const ctx = element?.getContext("2d");
    if (!element || !ctx) return;
    let active = true;
    if (photo instanceof HTMLVideoElement || photo instanceof FileVideo) {
      if (playing)
        void photo.play().catch(() => {
          if (active) setError("The background video could not play.");
        });
      else photo.pause();
    }
    let animation = 0;
    let last = 0;
    function frame(now: number) {
      if (!element || !ctx) return;
      if (playing && last) {
        motionTime.current += Math.min(now - last, 100) / 1000;
        angle.current =
          (angle.current +
            (Math.min(now - last, 100) / (options.duration * 1000)) * 360) %
          360;
      }
      last = now;
      drawCard(
        ctx,
        element.width,
        element.height,
        route,
        stats,
        options,
        angle.current,
        photo,
        motionTime.current,
      );
      if (playing) animation = requestAnimationFrame(frame);
    }
    animation = requestAnimationFrame(frame);
    return () => {
      active = false;
      cancelAnimationFrame(animation);
      if (photo instanceof HTMLVideoElement || photo instanceof FileVideo)
        photo.pause();
    };
  }, [route, stats, options, playing, photo]);

  useEffect(
    () => () => {
      abort.current?.abort();
      importVersion.current++;
      photoVersion.current++;
    },
    [],
  );

  async function importActivity(file: File | undefined) {
    if (!file || exporting) return;
    const version = ++importVersion.current;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const next = await parseFile(file);
      if (version !== importVersion.current) return;
      setActivity(next);
      setTrim(0);
      setOptions((previous) => ({
        ...previous,
        title: next.name,
        sport: next.sport,
      }));
      setNotice("Activity loaded. Your file stays on this device.");
    } catch (cause) {
      if (version === importVersion.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "The activity could not be opened.",
        );
    } finally {
      if (version === importVersion.current) setLoading(false);
    }
  }

  useEffect(() => () => releaseMedia(photo), [photo]);

  async function importPhoto(file: File | undefined) {
    if (!file) return;
    const version = ++photoVersion.current;
    setMediaLoading(false);
    setError("");
    const isVideo = file.type.startsWith("video/");
    if (file.size > (isVideo ? 100 * 1024 * 1024 : MAX_FILE_BYTES)) {
      setError(
        isVideo
          ? "Choose a video smaller than 100 MB."
          : "Choose a photo smaller than 20 MB.",
      );
      return;
    }
    if (
      !/^image\/(jpeg|png|webp)$/.test(file.type) &&
      !/^video\/(mp4|quicktime|webm)$/.test(file.type)
    ) {
      setError(
        "Choose a JPEG, PNG or WebP photo, or an MP4, MOV or WebM video.",
      );
      return;
    }
    setMediaLoading(true);
    if (isVideo) {
      try {
        const video = await loadVideoFile(file);
        if (version !== photoVersion.current) {
          releaseMedia(video);
          return;
        }
        setPhoto(video);
      } catch (cause) {
        if (version === photoVersion.current)
          setError(
            cause instanceof Error
              ? cause.message
              : "This video could not be opened.",
          );
      } finally {
        if (version === photoVersion.current) setMediaLoading(false);
      }
      return;
    }
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      if (version !== photoVersion.current) return;
      setPhoto(image);
    } catch {
      if (version === photoVersion.current)
        setError(
          "This photo could not be opened. Try exporting it as JPEG or PNG.",
        );
    } finally {
      URL.revokeObjectURL(url);
      if (version === photoVersion.current) setMediaLoading(false);
    }
  }

  async function save(kind: "png" | "gif" | "mp4") {
    if (!exportable || exporting || loading || mediaLoading) return;
    const controller = new AbortController();
    abort.current = controller;
    setExporting(true);
    setProgress(0);
    setError("");
    setNotice("");
    const snapshot = {
      ...options,
      angle: angle.current,
      motionTime: motionTime.current,
    };
    try {
      const blob =
        kind === "mp4"
          ? await exportVideo(
              points,
              snapshot,
              controller.signal,
              setProgress,
              photo,
            )
          : kind === "png"
            ? await exportPng(points, snapshot, photo)
            : await exportGif(
                points,
                snapshot,
                controller.signal,
                setProgress,
                photo,
              );
      if (!controller.signal.aborted) {
        download(blob, `trackmap-${snapshot.format}.${kind}`);
        setNotice(
          kind === "mp4"
            ? "MP4 ready. Save the video to Photos, then select it when creating your Instagram Story."
            : `${kind.toUpperCase()} ready. Check your downloads to save it. GIF and PNG overlays can be layered in an editor.`,
        );
      }
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Export failed. Please try again.",
        );
    } finally {
      setExporting(false);
      abort.current = null;
    }
  }

  return (
    <>
      <header className="site-header">
        <a href="/" aria-label="Trackmap home">
          trackmap.bent.build
        </a>
        <a href="https://bent.build">bent.build ↗</a>
      </header>
      <main>
        <h1>Trackmap</h1>
        <div className="workspace">
          <section className="preview-panel" aria-label="Activity card preview">
            <div className="panel-heading">
              <h2>Preview</h2>
              <span>{activity.demo ? "Sample activity" : activity.name}</span>
            </div>
            <div
              className={`preview-stage ${options.background === "transparent" && !photo ? "checkerboard" : ""}`}
            >
              <div className={`card-wrap ${options.format}`}>
                <canvas
                  ref={canvas}
                  width={720}
                  height={options.format === "story" ? 1280 : 720}
                  role="img"
                  aria-label={`3D route${options.showTitle ? ` for ${options.title}` : ""}. ${points.length} GPS points. Elevation ${options.exaggeration} times.${options.showStats ? ` ${stats.map((stat) => `${stat.label}: ${stat.value} ${stat.unit}`).join(". ")}.` : ""}`}
                />
              </div>
              {!exportable && (
                <p className="preview-warning">
                  The trim hides this route. Reduce it to export.
                </p>
              )}
            </div>
            <div className="preview-toolbar">
              <Button
                appearance="outline"
                onClick={() => setPlaying(!playing)}
                aria-label={playing ? "Pause rotation" : "Play rotation"}
              >
                {playing ? "Pause" : "Play"}
              </Button>
              <span>{options.duration}s per turn</span>
              <Button
                appearance="ghost"
                onClick={() => {
                  angle.current = 25;
                  motionTime.current = 0;
                  update("angle", 25);
                  update("tilt", 38);
                }}
              >
                Reset view
              </Button>
            </div>
            <dl className="activity-summary" aria-label="Activity statistics">
              {stats.map((stat) => (
                <div key={stat.label}>
                  <dt>{stat.label}</dt>
                  <dd>
                    {stat.value} <small>{stat.unit}</small>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
          <section className="editor" aria-label="Card editor">
            <fieldset disabled={exporting}>
              <legend>Activity</legend>
              <div
                className={`upload-zone ${dragging ? "is-dragging" : ""}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragging(false);
                  void importActivity(event.dataTransfer.files[0]);
                }}
              >
                <Button
                  appearance="outline"
                  disabled={loading}
                  onClick={() => fileInput.current?.click()}
                >
                  {loading ? "Reading…" : "Upload activity"}
                </Button>
                <span>or drop a file</span>
                <small>GPX / TCX / FIT / GeoJSON · 20 MB max</small>
                <Input
                  ref={fileInput}
                  type="file"
                  accept=".gpx,.tcx,.fit,.geojson,.json"
                  aria-label="Activity file"
                  hidden
                  onChange={(event) => {
                    void importActivity(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
              </div>
              <details>
                <summary>Export from Strava</summary>
                <p>
                  On Strava’s website, open the activity’s menu and select
                  Export GPX or Export Original.
                </p>
              </details>
              <div className="fields">
                <Field label="Activity title" htmlFor="title">
                  <Input
                    id="title"
                    maxLength={80}
                    value={options.title}
                    onChange={(event) => update("title", event.target.value)}
                  />
                </Field>
                <div className="two-columns">
                  <Field label="Activity" htmlFor="sport">
                    <Input
                      id="sport"
                      maxLength={30}
                      value={options.sport}
                      onChange={(event) => update("sport", event.target.value)}
                    />
                  </Field>
                  <Field label="Units" htmlFor="units">
                    <Select
                      id="units"
                      value={options.units}
                      onChange={(event) => {
                        if (
                          event.target.value === "km" ||
                          event.target.value === "mi"
                        )
                          update("units", event.target.value);
                      }}
                    >
                      <option value="km">Kilometres</option>
                      <option value="mi">Miles</option>
                    </Select>
                  </Field>
                </div>
              </div>
            </fieldset>
            <fieldset disabled={exporting}>
              <legend>Appearance</legend>
              <div className="fields">
                <div>
                  <span className="field-label" id="color-label">
                    Route colour
                  </span>
                  <div
                    className="swatches"
                    role="group"
                    aria-labelledby="color-label"
                  >
                    {colors.map((color) => (
                      <Button
                        appearance="outline"
                        key={color}
                        className="swatch"
                        style={{ backgroundColor: color }}
                        aria-label={`Route colour ${color}`}
                        aria-pressed={options.color === color}
                        onClick={() => update("color", color)}
                      >
                        <span
                          style={{
                            color: color === "#ffffff" ? "#111111" : "#ffffff",
                          }}
                        >
                          {options.color === color ? "✓" : ""}
                        </span>
                      </Button>
                    ))}
                    <Input
                      type="color"
                      aria-label="Custom route colour"
                      value={options.color}
                      onChange={(event) => update("color", event.target.value)}
                    />
                  </div>
                </div>
                <div>
                  <span className="field-label" id="background-label">
                    Background
                  </span>
                  <div
                    className="segments"
                    role="group"
                    aria-labelledby="background-label"
                  >
                    {(
                      [
                        "paper",
                        "ink",
                        "transparent",
                      ] satisfies CardOptions["background"][]
                    ).map((background) => (
                      <Button
                        appearance="outline"
                        key={background}
                        aria-pressed={
                          options.background === background && !photo
                        }
                        onClick={() => {
                          update("background", background);
                          photoVersion.current++;
                          setMediaLoading(false);
                          setPhoto(undefined);
                        }}
                      >
                        {background === "paper"
                          ? "White"
                          : background === "ink"
                            ? "Black"
                            : "Clear"}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="media-controls">
                  <Button
                    appearance="outline"
                    onClick={() => photoInput.current?.click()}
                  >
                    {mediaLoading
                      ? "Opening background…"
                      : "Add photo or video"}
                  </Button>
                  {photo && (
                    <Button
                      appearance="ghost"
                      onClick={() => {
                        photoVersion.current++;
                        setMediaLoading(false);
                        setPhoto(undefined);
                      }}
                    >
                      Remove
                    </Button>
                  )}
                  <Input
                    ref={photoInput}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm"
                    aria-label="Background photo or video"
                    hidden
                    onChange={(event) => {
                      void importPhoto(event.target.files?.[0]);
                      event.target.value = "";
                    }}
                  />
                </div>
                <Field label={`Camera tilt · ${options.tilt}°`} htmlFor="tilt">
                  <Input
                    id="tilt"
                    type="range"
                    min="15"
                    max="80"
                    value={options.tilt}
                    onChange={(event) =>
                      update("tilt", Number(event.target.value))
                    }
                  />
                </Field>
                <Field
                  label={`Elevation · ${options.exaggeration}×`}
                  htmlFor="elevation"
                >
                  <Input
                    id="elevation"
                    type="range"
                    min="1"
                    max="8"
                    step="0.5"
                    value={options.exaggeration}
                    onChange={(event) =>
                      update("exaggeration", Number(event.target.value))
                    }
                  />
                </Field>
                <Field
                  label={`Starting angle · ${options.angle}°`}
                  htmlFor="rotation"
                >
                  <Input
                    id="rotation"
                    type="range"
                    min="0"
                    max="359"
                    value={options.angle}
                    onChange={(event) => {
                      setPlaying(false);
                      update("angle", Number(event.target.value));
                    }}
                  />
                </Field>
                <Field label="Rotation speed" htmlFor="duration">
                  <Select
                    id="duration"
                    value={options.duration}
                    onChange={(event) =>
                      update("duration", Number(event.target.value))
                    }
                  >
                    <option value="4">4 seconds per turn</option>
                    <option value="6">6 seconds per turn</option>
                    <option value="8">8 seconds per turn</option>
                    <option value="15">15 seconds per turn</option>
                    <option value="30">30 seconds per turn</option>
                    <option value="60">60 seconds per turn</option>
                  </Select>
                </Field>
                <div className="toggles">
                  <label>
                    <Input
                      type="checkbox"
                      checked={options.pulse}
                      onChange={(event) =>
                        update("pulse", event.target.checked)
                      }
                    />
                    Route pulse
                  </label>
                  <label>
                    <Input
                      type="checkbox"
                      checked={options.showTitle}
                      onChange={(event) =>
                        update("showTitle", event.target.checked)
                      }
                    />
                    Titles
                  </label>
                  <label>
                    <Input
                      type="checkbox"
                      checked={options.showStats}
                      onChange={(event) =>
                        update("showStats", event.target.checked)
                      }
                    />
                    Stats
                  </label>
                </div>
                <details>
                  <summary>Privacy & route details</summary>
                  <Field label={`Hide each end · ${trim} m`} htmlFor="trim">
                    <Input
                      id="trim"
                      type="range"
                      min="0"
                      max="2000"
                      step="100"
                      value={trim}
                      onChange={(event) => setTrim(Number(event.target.value))}
                    />
                  </Field>
                  <p>
                    Trimmed points are excluded from previews, exports and
                    stats. Other visits to the same location may remain.
                  </p>
                  <p>
                    Elevation gain uses recorded uphill changes. Elapsed time
                    includes stops. Missing data appears as —.
                  </p>
                </details>
              </div>
            </fieldset>
            <fieldset disabled={exporting}>
              <legend>Export</legend>
              <div className="fields">
                <Field label="Frame" htmlFor="format">
                  <Select
                    id="format"
                    value={options.format}
                    onChange={(event) => {
                      if (
                        event.target.value === "story" ||
                        event.target.value === "square"
                      )
                        update("format", event.target.value);
                    }}
                  >
                    <option value="story">Story · 9:16</option>
                    <option value="square">Square · 1:1</option>
                  </Select>
                </Field>
                <Button
                  appearance="primary"
                  disabled={!exportable || loading || mediaLoading}
                  onClick={() => void save("mp4")}
                >
                  Export Story video · MP4
                </Button>
                <div className="two-columns">
                  <Button
                    appearance="outline"
                    disabled={!exportable || loading || mediaLoading}
                    onClick={() => void save("gif")}
                  >
                    Export animated GIF
                  </Button>
                  <Button
                    appearance="outline"
                    disabled={!exportable || loading || mediaLoading}
                    onClick={() => void save("png")}
                  >
                    Save PNG
                  </Button>
                </div>
              </div>
            </fieldset>
            {exporting && (
              <div className="export-progress" role="status">
                <span>Exporting · {progress}%</span>
                <progress value={progress} max="100" />
                <Button
                  appearance="ghost"
                  onClick={() => abort.current?.abort()}
                >
                  Cancel export
                </Button>
              </div>
            )}
            {error && (
              <p className="message error" role="alert">
                {error}
              </p>
            )}
            {notice && (
              <p className="message" role="status">
                {notice}
              </p>
            )}
            <p className="file-note">
              MP4: 1080px, silent. PNG: 1080px. GIF: 540px, 12fps. Clear
              preserves transparency in PNG/GIF. MP4 uses a solid background.
            </p>
            <details>
              <summary>Share to Instagram</summary>
              <p>
                Save the MP4 to Photos and select it in Instagram’s Story
                editor. Your route and background are combined in the video.
              </p>
              <p>
                Transparent GIF/PNG files can be layered in an editor. Movable
                stickers inside Instagram use{" "}
                <a href="https://support.giphy.com/hc/en-us/articles/360020235351-Get-Your-Stickers-and-GIFs-Into-Instagram-Stories">
                  GIPHY publishing
                </a>
                .
              </p>
            </details>
            <p className="file-note">Files stay on your device.</p>
          </section>
        </div>
        <footer>
          <a href="https://bent.build">bent.build</a>
          <a href="/third-party-notices.txt">Licenses</a>
        </footer>
      </main>
    </>
  );
}
