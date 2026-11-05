// Experimental editor lifecycle. These revisions belong to one immutable
// source upload, independently of settings edits. No production routes use it.
export function createPreviewState(revision, settings) {
  return { revision, settings: { ...settings }, preview: null, phase: "processing", error: null };
}

export function transitionPreview(state, event) {
  if (event.revision !== state.revision) return state;
  switch (event.type) {
    case "settings":
      return { ...state, settings: { ...event.settings } };
    case "early":
      if (state.phase !== "processing") return state;
      return { ...state, preview: event.preview, phase: "editing" };
    case "final":
      // The caller decodes the final preview before signalling completion.
      // Never re-run placement suggestions or reset edits during replacement.
      return { ...state, preview: event.preview, phase: "ready", error: null };
    case "failure":
      if (state.phase === "ready") return state;
      return { ...state, phase: "failed", error: event.message };
    default:
      throw new Error("Unknown preview transition.");
  }
}

export function canContinue(state) {
  return state.phase === "ready";
}
