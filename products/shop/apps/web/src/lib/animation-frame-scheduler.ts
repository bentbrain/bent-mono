export interface AnimationFrameScheduler<Value extends object> {
  cancel: () => void;
  flush: () => void;
  schedule: (value: Value) => void;
}

interface AnimationFrameSchedulerOptions<Value extends object> {
  readonly cancelFrame: (handle: number) => void;
  readonly commit: (value: Value) => void;
  readonly requestFrame: (callback: () => void) => number;
}

export function createAnimationFrameScheduler<Value extends object>({
  cancelFrame,
  commit,
  requestFrame,
}: AnimationFrameSchedulerOptions<Value>): AnimationFrameScheduler<Value> {
  let frame: number | undefined;
  let pending: Value | undefined;
  let hasPending = false;

  function commitPending() {
    frame = undefined;
    if (!hasPending) return;
    const value = pending;
    pending = undefined;
    hasPending = false;
    if (value === undefined) return;
    commit(value);
  }

  return {
    cancel() {
      if (frame !== undefined) cancelFrame(frame);
      frame = undefined;
      pending = undefined;
      hasPending = false;
    },
    flush() {
      if (frame !== undefined) cancelFrame(frame);
      commitPending();
    },
    schedule(value) {
      pending = value;
      hasPending = true;
      if (frame !== undefined) return;
      frame = requestFrame(commitPending);
    },
  };
}
