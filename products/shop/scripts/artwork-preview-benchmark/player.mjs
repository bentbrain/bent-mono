import { createElement } from "../../apps/web/node_modules/react/index.js";
import { createRoot } from "../../apps/web/node_modules/react-dom/client.js";
import { ProcessedCutoutReveal } from "../../apps/web/src/components/processed-cutout-reveal.tsx";
import { renderRecursiveImage, suggestSettings } from "../../apps/web/src/lib/recursive-image.ts";
import { applyDirectManipulation, editingLayerAtPoint, gestureMetrics } from "../../apps/web/src/lib/editor-direct-manipulation.ts";
import { canContinue, createPreviewState, transitionPreview } from "./state.mjs";

const data = await (await fetch("data.json")).json();
const bitmap = async url => createImageBitmap(await (await fetch(url)).blob());
const [early, final, baseline, original] = await Promise.all(["early.webp", "final.webp", "baseline.webp", "source.jpg"].map(bitmap));
const defaults = { ...suggestSettings(early), removeBackground: true };
const storageKey = "artwork-preview-prototype-v1";
const speedControl = document.querySelector("#speed");
let saved;
try { saved = JSON.parse(localStorage.getItem(storageKey)); } catch { /* No saved prototype. */ }
let startedAt = saved?.startedAt ?? Date.now();
let speed = saved?.speed ?? 1;
speedControl.value = String(speed);
let revision = saved?.revision ?? crypto.randomUUID();
const panels = [
  { element: document.querySelector("#progressive"), key: "progressive", earlyMs: data.timing.earlyMs,
    finalMs: data.events.find(event => event.name === "final-preview").elapsedMs, early, final },
  { element: document.querySelector("#baseline"), key: "baseline",
    earlyMs: data.baseline.find(event => event.name === "final-preview").elapsedMs,
    finalMs: data.baseline.find(event => event.name === "final-preview").elapsedMs, early: baseline, final: baseline },
];

function persist() {
  localStorage.setItem(storageKey, JSON.stringify({ startedAt, speed, revision,
    settings: Object.fromEntries(panels.map(panel => [panel.key, panel.state.settings])) }));
}

function paint(panel) {
  const { element, state } = panel;
  if (state.preview) renderRecursiveImage(panel.canvas, state.settings.removeBackground === false ? original : state.preview, state.settings);
  element.dataset.phase = state.phase;
  element.dataset.settings = JSON.stringify(state.settings);
  panel.background.disabled = !state.preview || panel.revealing;
  panel.effect.disabled = !state.preview || panel.revealing;
  panel.background.checked = state.settings.removeBackground === false;
  panel.effect.checked = state.settings.depth > 0;
  element.querySelector(".continue").disabled = !canContinue(state) || panel.revealing;
  element.querySelector(".readiness").textContent = panel.revealing ? "Preparing canvas…"
    : state.phase === "ready" ? "Ready." : state.preview ? "Preparing print artwork. You can keep editing." : "Preparing photo…";
}

function update(panel, settings) {
  panel.state = transitionPreview(panel.state, { type: "settings", revision, settings });
  paint(panel); persist();
}

function reveal(panel) {
  panel.revealing = true;
  const currentRevision = revision;
  panel.revealRoot.render(createElement(ProcessedCutoutReveal, {
    imageUrl: panel.key === "progressive" ? "early.webp" : "baseline.webp",
    onCovered() { if (revision === currentRevision) panel.photo.hidden = true; },
    onComplete() {
      if (revision !== currentRevision) return;
      panel.revealing = false;
      panel.photo.hidden = true;
      panel.revealRoot.render(null);
      paint(panel);
    },
  }));
}

for (const panel of panels) {
  const { element } = panel;
  panel.canvas = element.querySelector("canvas");
  panel.photo = element.querySelector(".photo");
  panel.background = element.querySelector(".background");
  panel.effect = element.querySelector(".effect");
  panel.revealRoot = createRoot(element.querySelector(".reveal"));
  panel.state = createPreviewState(revision, saved?.settings?.[panel.key] ?? defaults);
  panel.revealing = false;
  panel.background.addEventListener("change", () => update(panel, { ...panel.state.settings, removeBackground: !panel.background.checked }));
  panel.effect.addEventListener("change", () => update(panel, { ...panel.state.settings, depth: panel.effect.checked ? 5 : 0 }));
  element.querySelector(".continue").addEventListener("click", () => {
    element.querySelector("output").textContent = "Prototype complete. No product was created.";
  });
  const pointers = new Map();
  let gesture;
  const position = event => {
    const box = panel.canvas.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };
  panel.canvas.addEventListener("pointerdown", event => {
    if (!panel.state.preview || panel.revealing) return;
    panel.canvas.setPointerCapture(event.pointerId);
    const point = position(event);
    pointers.set(event.pointerId, point);
    const box = panel.canvas.getBoundingClientRect();
    gesture = { settings: panel.state.settings, metrics: gestureMetrics(pointers),
      layer: editingLayerAtPoint(panel.state.settings, point.x / box.width, point.y / box.height) };
  });
  panel.canvas.addEventListener("pointermove", event => {
    if (!gesture || !pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, position(event));
    const box = panel.canvas.getBoundingClientRect();
    update(panel, applyDirectManipulation(gesture.layer, gesture.settings, gesture.metrics, gestureMetrics(pointers), box.width, box.height));
  });
  const end = event => { pointers.delete(event.pointerId); gesture = undefined; };
  panel.canvas.addEventListener("pointerup", end);
  panel.canvas.addEventListener("pointercancel", end);
  panel.canvas.addEventListener("keydown", event => {
    if (!panel.state.preview || panel.revealing) return;
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const deltaX = event.key === "ArrowLeft" ? -0.01 : event.key === "ArrowRight" ? 0.01 : 0;
    const deltaY = event.key === "ArrowUp" ? -0.01 : event.key === "ArrowDown" ? 0.01 : 0;
    update(panel, { ...panel.state.settings, cropX: Math.min(1, Math.max(0, panel.state.settings.cropX + deltaX)),
      cropY: Math.min(1, Math.max(0, panel.state.settings.cropY + deltaY)) });
  });
  element.querySelector(".measurement").textContent = `Preview ${(panel.earlyMs / 1000).toFixed(1)} s · final display ${(panel.finalMs / 1000).toFixed(1)} s, before reveal`;
  paint(panel);
}

function restart() {
  revision = crypto.randomUUID(); startedAt = Date.now(); speed = Number(speedControl.value);
  for (const panel of panels) {
    panel.revealRoot.render(null); panel.revealing = false;
    panel.state = createPreviewState(revision, defaults);
    panel.canvas.getContext("2d").clearRect(0, 0, panel.canvas.width, panel.canvas.height);
    panel.photo.hidden = false;
    panel.element.querySelector("output").textContent = "";
    paint(panel);
  }
  persist();
}
document.querySelector("#replay").addEventListener("click", restart);
speedControl.addEventListener("change", restart);
document.querySelector("#replay").disabled = false;
speedControl.disabled = false;

function tick() {
  const elapsed = (Date.now() - startedAt) * speed;
  document.querySelector("#clock").textContent = `${(elapsed / 1000).toFixed(1)} s`;
  for (const panel of panels) {
    if (elapsed >= panel.earlyMs && panel.state.phase === "processing") {
      panel.state = transitionPreview(panel.state, { type: "early", revision, preview: panel.early });
      reveal(panel); paint(panel);
    }
    if (elapsed >= panel.finalMs && panel.state.phase !== "ready") {
      panel.state = transitionPreview(panel.state, { type: "final", revision, preview: panel.final });
      paint(panel);
    }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
