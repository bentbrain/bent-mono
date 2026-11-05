const selector = 'video[data-visibility-video], .rich-text .emdash-video video';
const controllers = new WeakMap<HTMLElement, () => void>();

type Playback = {
  visible: boolean;
  ratio: number;
  manualPause: boolean;
  attempted: boolean;
  pending: boolean;
  generation: number;
  expectedPauses: number;
};

/** One controller for public SSR videos and React popup/carousel videos. */
export function startPublicVideoPlayback(root: HTMLElement) {
  if (controllers.has(root)) return controllers.get(root);
  if (
    typeof IntersectionObserver === 'undefined' ||
    typeof ResizeObserver === 'undefined'
  )
    return;
  const videos = new Map<HTMLVideoElement, Playback>();
  let suspended = false;
  let disposed = false;

  function rendered(video: HTMLVideoElement) {
    if (typeof video.checkVisibility === 'function') {
      return video.checkVisibility({ visibilityProperty: true });
    }
    return (
      getComputedStyle(video).visibility === 'visible' &&
      video.getClientRects().length > 0
    );
  }

  function eligible(video: HTMLVideoElement, state: Playback) {
    return (
      !disposed &&
      !suspended &&
      !document.hidden &&
      video.isConnected &&
      root.contains(video) &&
      videos.get(video) === state &&
      state.visible &&
      rendered(video)
    );
  }

  function pause(video: HTMLVideoElement, state: Playback) {
    state.generation++;
    state.pending = false;
    if (!video.paused) {
      state.expectedPauses++;
      video.pause();
    }
  }

  function update(video: HTMLVideoElement, state: Playback) {
    const active = !video.closest('[data-video-active="false"]');
    // Ratios use the area that can fit in the viewport, so a tall portrait
    // can qualify. Hysteresis avoids toggling at the visibility boundary.
    const visible =
      active && rendered(video) && state.ratio >= (state.visible ? 0.2 : 0.6);
    if (!visible) {
      state.manualPause = false;
      state.attempted = false;
    }
    state.visible = visible;
    if (!eligible(video, state)) {
      pause(video, state);
      return;
    }
    // Native controls change paused before their queued play event arrives.
    // A manual pause blocks automatic starts, not an already resumed player.
    if (state.manualPause || !video.paused || state.pending || state.attempted)
      return;
    state.attempted = true;
    state.pending = true;
    const generation = ++state.generation;
    // Every automatic start, including a scroll/tab return, is silent. An
    // explicit unmute is left alone for the rest of that visible session.
    video.muted = true;
    void video
      .play()
      .then(() => {
        const current = videos.get(video);
        if (current === state && generation === state.generation)
          state.pending = false;
        // A retired request may finish after the same element has registered
        // again. Apply current ownership without pausing valid new playback.
        if (current) {
          if (!eligible(video, current)) update(video, current);
        } else {
          pause(video, state);
        }
      })
      .catch(() => {
        if (videos.get(video) === state && generation === state.generation)
          state.pending = false;
        // Blocked autoplay leaves native controls available, without retry loops.
      });
  }

  let intersection: IntersectionObserver | undefined;
  let observation = 0;
  let frame: number | undefined;
  function rebuildIntersection() {
    frame = undefined;
    if (disposed) return;
    intersection?.disconnect();
    const thresholds = new Set([0, 0.2, 0.6, 1]);
    for (const video of videos.keys()) {
      const box = video.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const available =
        Math.min(1, document.documentElement.clientWidth / box.width) *
        Math.min(1, document.documentElement.clientHeight / box.height);
      thresholds.add(available * 0.2);
      thresholds.add(available * 0.6);
    }
    const version = ++observation;
    intersection = new IntersectionObserver(
      (entries) => {
        if (disposed || version !== observation) return;
        for (const entry of entries) {
          if (!(entry.target instanceof HTMLVideoElement)) continue;
          const state = videos.get(entry.target);
          if (!state) continue;
          const box = entry.boundingClientRect;
          const available =
            Math.min(box.width, entry.rootBounds?.width ?? innerWidth) *
            Math.min(box.height, entry.rootBounds?.height ?? innerHeight);
          state.ratio =
            entry.isIntersecting && available > 0
              ? (entry.intersectionRect.width * entry.intersectionRect.height) /
                available
              : 0;
          update(entry.target, state);
        }
      },
      { threshold: [...thresholds].sort((a, b) => a - b) },
    );
    for (const video of videos.keys()) intersection.observe(video);
  }
  function scheduleIntersection() {
    if (frame === undefined) frame = requestAnimationFrame(rebuildIntersection);
  }
  const sizes = new ResizeObserver(scheduleIntersection);

  function register(element: Element) {
    if (
      !(element instanceof HTMLVideoElement) ||
      !root.contains(element) ||
      videos.has(element)
    )
      return;
    element.autoplay = false;
    element.muted = true;
    element.loop = true;
    element.playsInline = true;
    videos.set(element, {
      visible: false,
      ratio: 0,
      manualPause: false,
      attempted: false,
      pending: false,
      generation: 0,
      expectedPauses: 0,
    });
    sizes.observe(element);
    scheduleIntersection();
  }
  function add(element: Element) {
    if (element.matches(selector)) register(element);
    element.querySelectorAll(selector).forEach(register);
  }
  const visibilityUpdates = new Set<HTMLVideoElement>();
  let visibilityFrame: number | undefined;
  function flushVisibility() {
    visibilityFrame = undefined;
    for (const video of visibilityUpdates) {
      const state = videos.get(video);
      if (state) update(video, state);
    }
    visibilityUpdates.clear();
  }
  function queueVisibility(element: Element) {
    if (element instanceof HTMLVideoElement && videos.has(element))
      visibilityUpdates.add(element);
    for (const video of element.querySelectorAll('video')) {
      if (video instanceof HTMLVideoElement && videos.has(video))
        visibilityUpdates.add(video);
    }
    // Class/style churn, including carousel transforms, is scoped to affected
    // players and coalesced once per frame. Playback writes no class/style.
    if (visibilityUpdates.size && visibilityFrame === undefined) {
      visibilityFrame = requestAnimationFrame(flushVisibility);
    }
  }
  const mutations = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes)
        if (node instanceof Element) add(node);
      if (record.type === 'attributes' && record.target instanceof Element) {
        queueVisibility(record.target);
      }
    }
    for (const [video, state] of videos) {
      if (video.isConnected && root.contains(video)) continue;
      state.visible = false;
      pause(video, state);
      intersection?.unobserve(video);
      sizes.unobserve(video);
      visibilityUpdates.delete(video);
      videos.delete(video);
    }
  });

  function onPause(event: Event) {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement)) return;
    const state = videos.get(video);
    if (!state) return;
    if (state.expectedPauses) {
      state.expectedPauses--;
      return;
    }
    if (video.paused && state.visible && !document.hidden && !suspended) {
      state.manualPause = true;
    }
  }
  function onPlay(event: Event) {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement)) return;
    const state = videos.get(video);
    if (!state) return;
    state.manualPause = false;
    if (!eligible(video, state)) pause(video, state);
  }
  function visibility() {
    for (const [video, state] of videos) {
      if (document.hidden || suspended) state.attempted = false;
      update(video, state);
    }
  }
  function pageHide(event: PageTransitionEvent) {
    suspended = true;
    visibility();
    if (!event.persisted) cleanup();
  }
  function pageShow() {
    suspended = false;
    visibility();
  }
  function cleanup() {
    disposed = true;
    intersection?.disconnect();
    sizes.disconnect();
    if (frame !== undefined) cancelAnimationFrame(frame);
    mutations.disconnect();
    if (visibilityFrame !== undefined) cancelAnimationFrame(visibilityFrame);
    visibilityUpdates.clear();
    for (const [video, state] of videos) pause(video, state);
    videos.clear();
    root.removeEventListener('play', onPlay, true);
    root.removeEventListener('pause', onPause, true);
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('pagehide', pageHide);
    window.removeEventListener('pageshow', pageShow);
    window.removeEventListener('resize', scheduleIntersection);
    controllers.delete(root);
  }
  root.addEventListener('play', onPlay, true);
  root.addEventListener('pause', onPause, true);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', pageHide);
  window.addEventListener('pageshow', pageShow);
  window.addEventListener('resize', scheduleIntersection);
  mutations.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-video-active', 'class', 'style', 'hidden'],
  });
  // Inherited visibility may change above the controlled root as well.
  for (
    let ancestor = root.parentElement;
    ancestor;
    ancestor = ancestor.parentElement
  ) {
    mutations.observe(ancestor, {
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
    });
  }
  add(root);
  controllers.set(root, cleanup);
  return cleanup;
}
