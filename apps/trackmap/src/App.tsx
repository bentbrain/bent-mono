import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@bent/ui/button";
import type { Activity } from "./activity";
import { demoActivity, MAX_FILE_BYTES, parseFile, trimRoute } from "./activity";
import type { CardOptions } from "./render";
import { cardStats, drawCard, prepareRoute } from "./render";
import { download, exportGif, exportPng, exportVideo } from "./export";

import type { CardMedia } from "./media";
import { loadVideo, releaseMedia } from "./media";

const initialOptions: CardOptions = {
  title: "A little further",
  sport: "Trail run",
  color: "#c4f56e",
  background: "ink",
  format: "story",
  showStats: true,
  showTitle: true,
  units: "km",
  tilt: 38,
  exaggeration: 3,
  angle: 25,
  duration: 6,
};
const colors = [
  "#c4f56e",
  "#ff865e",
  "#64d8ff",
  "#c4a1ff",
  "#ffffff",
  "#0647ff",
];

function Mark() {
  return (
    <svg
      width="31"
      height="31"
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3 25 11 7l7 15L29 6l-8 22Z"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

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
    if (photo instanceof HTMLVideoElement) {
      if (playing)
        void photo
          .play()
          .catch(() => setError("The background video could not play."));
      else photo.pause();
    }
    let animation = 0;
    let last = 0;
    function frame(now: number) {
      if (!element || !ctx) return;
      if (playing && last)
        angle.current =
          (angle.current +
            (Math.min(now - last, 100) / (options.duration * 1000)) * 360) %
          360;
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
      );
      if (playing) animation = requestAnimationFrame(frame);
    }
    animation = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(animation);
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
    const url = URL.createObjectURL(file);
    if (isVideo) {
      try {
        const video = await loadVideo(url);
        if (version !== photoVersion.current) {
          releaseMedia(video);
          return;
        }
        setPhoto(video);
      } catch (cause) {
        URL.revokeObjectURL(url);
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
    const snapshot = { ...options, angle: angle.current };
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
        <a className="wordmark" href="/" aria-label="Trackmap home">
          <Mark />
          trackmap<span className="brand-dot">.</span>
        </a>
        <div className="header-note">A NEW WAY TO LOOK BACK.</div>
        <a className="bent-link" href="https://bent.build">
          by bent ↗
        </a>
      </header>
      <main>
        <section className="intro" aria-labelledby="page-title">
          <div>
            <p className="eyebrow">
              <span className="status-dot" /> THE ROUTE WAS ONLY THE BEGINNING
            </p>
            <h1 id="page-title">
              Your effort.
              <br />
              <span>Another dimension.</span>
            </h1>
          </div>
          <p className="intro-copy">
            A morning run. A long way home.
            <br />
            Turn your activity into a moving piece
            <br className="desktop-break" /> of art, ready for your next story.
          </p>
        </section>
        <div className="workspace">
          <section className="preview-panel" aria-label="Activity card preview">
            <div className="panel-top">
              <span>
                <span className="status-dot" /> LIVE PREVIEW
              </span>
              <span>{activity.demo ? "SYNTHETIC DEMO" : "YOUR ACTIVITY"}</span>
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
                  aria-label={`Rotating 3D route for ${options.title}. ${points.length} GPS points. Elevation is exaggerated ${options.exaggeration} times.`}
                />
              </div>
              {!exportable && (
                <div className="preview-warning">
                  The privacy trim hides this entire route. Reduce it to export.
                </div>
              )}
            </div>
            <div className="preview-toolbar">
              <Button
                className="play-button"
                onClick={() => setPlaying(!playing)}
                aria-label={playing ? "Pause rotation" : "Play rotation"}
              >
                {playing ? "Ⅱ" : "▷"}
                <span>{playing ? "Pause orbit" : "Play orbit"}</span>
              </Button>
              <span>
                360° ORBIT <span className="toolbar-divider">/</span>{" "}
                {options.duration}S LOOP
              </span>
              <Button
                className="text-button"
                onClick={() => {
                  angle.current = 25;
                  update("angle", 25);
                  update("tilt", 38);
                }}
              >
                Reset view ↺
              </Button>
            </div>
            <div className="activity-summary" aria-label="Activity statistics">
              {stats.map((stat) => (
                <div key={stat.label}>
                  <span>{stat.label}</span>
                  <strong>
                    {stat.value} <small>{stat.unit}</small>
                  </strong>
                </div>
              ))}
            </div>
            <p className="preview-footnote">
              {activity.demo
                ? "An invented trail, for a little inspiration. Upload yours to make it personal."
                : "GPS geometry + recorded elevation. No map tiles or invented terrain."}
            </p>
          </section>
          <section className="editor" aria-label="Card editor">
            <div className="editor-heading">
              <h2>Make it yours</h2>
              <span>01—03</span>
            </div>
            <fieldset disabled={exporting}>
              <legend className="step">
                <span>01</span> Bring your adventure
              </legend>
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
                <span className="upload-symbol" aria-hidden="true">
                  ↥
                </span>
                <Button
                  className="upload-button"
                  disabled={loading}
                  onClick={() => fileInput.current?.click()}
                >
                  {loading ? "Reading activity…" : "Choose an activity"}
                </Button>
                <p>or drop it here</p>
                <small>GPX, TCX, FIT, GEOJSON · UP TO 20 MB</small>
                <input
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
              <details className="help">
                <summary>Coming from Strava?</summary>
                <p>
                  On Strava’s website, open your activity, choose the three-dot
                  menu, then Export GPX or Export Original. Upload that file
                  here. Garmin, Wahoo and other GPS exports work too. No
                  connection to your Strava account is needed.
                </p>
              </details>
              <div className="step">
                <span>02</span> Set the scene
              </div>
              <label className="field-label" htmlFor="title">
                Activity title
              </label>
              <input
                id="title"
                className="text-input"
                maxLength={80}
                value={options.title}
                onChange={(event) => update("title", event.target.value)}
              />
              <div className="two-columns">
                <div>
                  <label className="field-label" htmlFor="sport">
                    Activity
                  </label>
                  <input
                    id="sport"
                    className="text-input"
                    maxLength={30}
                    value={options.sport}
                    onChange={(event) => update("sport", event.target.value)}
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="units">
                    Units
                  </label>
                  <select
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
                  </select>
                </div>
              </div>
              <div className="field-label" id="color-label">
                Route colour
              </div>
              <div
                className="swatches"
                role="group"
                aria-labelledby="color-label"
              >
                {colors.map((color) => (
                  <Button
                    key={color}
                    className={`swatch ${options.color === color ? "selected" : ""}`}
                    style={{ backgroundColor: color }}
                    aria-label={`Route colour ${color}`}
                    aria-pressed={options.color === color}
                    onClick={() => update("color", color)}
                  >
                    {options.color === color ? (
                      <span
                        style={{
                          color: color === "#0647ff" ? "white" : "#142039",
                        }}
                      >
                        ✓
                      </span>
                    ) : null}
                  </Button>
                ))}
                <label className="custom-color" title="Custom route colour">
                  <span>＋</span>
                  <input
                    type="color"
                    aria-label="Custom route colour"
                    value={options.color}
                    onChange={(event) => update("color", event.target.value)}
                  />
                </label>
              </div>
              <div className="field-label" id="background-label">
                Canvas
              </div>
              <div
                className="segments"
                role="group"
                aria-labelledby="background-label"
              >
                {(
                  [
                    "ink",
                    "paper",
                    "transparent",
                  ] satisfies CardOptions["background"][]
                ).map((background) => (
                  <Button
                    key={background}
                    className={
                      options.background === background ? "active" : ""
                    }
                    aria-pressed={options.background === background}
                    onClick={() => {
                      update("background", background);
                      photoVersion.current++;
                      setMediaLoading(false);
                      setPhoto(undefined);
                    }}
                  >
                    {background === "ink"
                      ? "● Ink"
                      : background === "paper"
                        ? "○ Paper"
                        : "▧ Clear"}
                  </Button>
                ))}
              </div>
              <div className="photo-row">
                <Button
                  className="text-button"
                  onClick={() => photoInput.current?.click()}
                >
                  {mediaLoading
                    ? "Opening background…"
                    : "＋ Add a photo or video"}
                </Button>
                {photo && (
                  <Button
                    className="text-button"
                    onClick={() => {
                      photoVersion.current++;
                      setMediaLoading(false);
                      setPhoto(undefined);
                    }}
                  >
                    Remove
                  </Button>
                )}
                <input
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
              <label className="range-label" htmlFor="tilt">
                Camera tilt <span>{options.tilt}°</span>
              </label>
              <input
                id="tilt"
                type="range"
                min="15"
                max="80"
                value={options.tilt}
                onChange={(event) => update("tilt", Number(event.target.value))}
              />
              <label className="range-label" htmlFor="elevation">
                Elevation lift <span>{options.exaggeration}×</span>
              </label>
              <input
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
              <label className="range-label" htmlFor="rotation">
                Starting angle <span>{options.angle}°</span>
              </label>
              <input
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
              <div className="toggle-row">
                <label>
                  <input
                    type="checkbox"
                    checked={options.showTitle}
                    onChange={(event) =>
                      update("showTitle", event.target.checked)
                    }
                  />{" "}
                  Title
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={options.showStats}
                    onChange={(event) =>
                      update("showStats", event.target.checked)
                    }
                  />{" "}
                  Stats
                </label>
              </div>
              <details className="privacy-settings">
                <summary>Privacy & route details</summary>
                <label className="range-label" htmlFor="trim">
                  Hide each end <span>{trim} m</span>
                </label>
                <input
                  id="trim"
                  type="range"
                  min="0"
                  max="2000"
                  step="100"
                  value={trim}
                  onChange={(event) => setTrim(Number(event.target.value))}
                />
                <p>
                  Removes at least this distance from each end. Preview and
                  exports use only the remaining route and its stats. Check for
                  other sensitive locations before sharing. Repeated visits to
                  your start location can still be visible.
                </p>
                <p>
                  Elevation gain is the sum of recorded uphill changes, without
                  smoothing. Time is elapsed, including stops. Missing data
                  appears as —.
                </p>
              </details>
              <div className="step">
                <span>03</span> Take it with you
              </div>
              <div className="two-columns">
                <div>
                  <label className="field-label" htmlFor="format">
                    Frame
                  </label>
                  <select
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
                  </select>
                </div>
                <div>
                  <label className="field-label" htmlFor="duration">
                    Loop length
                  </label>
                  <select
                    id="duration"
                    value={options.duration}
                    onChange={(event) =>
                      update("duration", Number(event.target.value))
                    }
                  >
                    <option value="4">4 seconds</option>
                    <option value="6">6 seconds</option>
                    <option value="8">8 seconds</option>
                  </select>
                </div>
              </div>
              <Button
                className="primary-button video-export"
                disabled={!exportable || loading || mediaLoading}
                onClick={() => void save("mp4")}
              >
                Export Story video · MP4 <span>↓</span>
              </Button>
              <div className="export-buttons">
                <Button
                  className="secondary-button"
                  disabled={!exportable || loading || mediaLoading}
                  onClick={() => void save("gif")}
                >
                  Export animated GIF <span>↓</span>
                </Button>
                <Button
                  className="secondary-button"
                  disabled={!exportable || loading || mediaLoading}
                  onClick={() => void save("png")}
                >
                  Save PNG <span>↗</span>
                </Button>
              </div>
            </fieldset>
            {exporting && (
              <div className="export-progress" role="status">
                <span>Making your export… {progress}%</span>
                <progress value={progress} max="100" />
                <Button
                  className="text-button"
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
            <p className="export-note">
              MP4 · 1080 px, silent. PNG · 1080 px. GIF · 540 px, 12 fps.
              <br />
              Choose Clear for a transparent overlay. The checkerboard is never
              exported. Video combines the route with your background, using Ink
              when Clear has no photo or video.
            </p>
            <details className="sharing-help">
              <summary>How to add it to your Instagram Story</summary>
              <p>
                Choose a photo or video background, then export a Story video.
                Save the MP4 to Photos and select it in Instagram’s Story
                editor. The animated route is already part of the video.
              </p>
              <p>
                Transparent GIF and PNG files are layers for a photo/video
                editor. Instagram does not provide a dependable GIF paste
                workflow.
              </p>
              <p>
                For a movable animated sticker inside Instagram, use{" "}
                <a href="https://support.giphy.com/hc/en-us/articles/360020235351-Get-Your-Stickers-and-GIFs-Into-Instagram-Stories">
                  GIPHY’s sticker publishing route
                </a>
                . It involves public publishing and moderation. Trackmap never
                publishes your GPS data to GIPHY.
              </p>
            </details>
            <div className="privacy-note">
              <span aria-hidden="true">⌁</span>
              <p>
                Your miles are yours.
                <br />
                <span>
                  Files are processed here, on your device. Nothing is uploaded
                  or saved to a server.
                </span>
              </p>
            </div>
          </section>
        </div>
        <footer>
          <a className="wordmark" href="/">
            trackmap.
          </a>
          <span>GO SOMEWHERE. MAKE SOMETHING.</span>
          <a href="/third-party-notices.txt">Third-party licenses</a>
          <a href="https://bent.build">A little experiment by bent ↗</a>
        </footer>
      </main>
    </>
  );
}
