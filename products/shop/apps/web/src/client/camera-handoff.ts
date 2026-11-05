// A single, short-lived handoff. Nothing is serialized into history or storage.
let pending: { id: string; stream: MediaStream; cleanup: () => void } | undefined;

export function retainCameraForDraft(id: string, stream: MediaStream) {
  discardCameraHandoff();
  const expire = () => { discardCameraHandoff(); };
  const hidden = () => { if (document.visibilityState === "hidden") expire(); };
  const timeout = window.setTimeout(expire, 15_000);
  window.addEventListener("pagehide", expire);
  document.addEventListener("visibilitychange", hidden);
  pending = { id, stream, cleanup: () => {
    window.clearTimeout(timeout);
    window.removeEventListener("pagehide", expire);
    document.removeEventListener("visibilitychange", hidden);
  } };
}

export function takeCameraForDraft(id: string) {
  if (pending?.id !== id) return undefined;
  const handoff = pending;
  pending = undefined;
  handoff.cleanup();
  if (!handoff.stream.getVideoTracks().some(track => track.readyState === "live")) {
    handoff.stream.getTracks().forEach(track => { track.stop(); });
    return undefined;
  }
  return handoff.stream;
}

export function discardCameraHandoff() {
  const handoff = pending;
  pending = undefined;
  handoff?.cleanup();
  handoff?.stream.getTracks().forEach(track => { track.stop(); });
}
