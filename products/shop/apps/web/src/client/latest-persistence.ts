interface PersistenceTask<Value> {
  readonly enqueuedAt: number;
  readonly sequence: number;
  readonly supersededCount: number;
  readonly value: Value;
}

interface PersistenceSuccess<Value, Result> {
  readonly queueMs: number;
  readonly requestMs: number;
  readonly result: Result;
  readonly supersededCount: number;
  readonly value: Value;
}

interface PersistenceFailure<Value> {
  readonly error: unknown;
  readonly queueMs: number;
  readonly requestMs: number;
  readonly supersededCount: number;
  readonly value: Value;
}

interface LatestPersistenceOptions<Value, Result> {
  readonly isSameValue?: (left: Value, right: Value) => boolean;
  readonly now?: () => number;
  readonly onFailure?: (failure: PersistenceFailure<Value>) => void;
  readonly onPendingChange?: (pending: boolean) => void;
  readonly onSuccess?: (success: PersistenceSuccess<Value, Result>) => void;
  readonly save: (value: Value) => Promise<Result>;
}

export function createLatestPersistence<Value, Result>(
  options: LatestPersistenceOptions<Value, Result>,
) {
  const now = options.now ?? (() => performance.now());
  const isSameValue = options.isSameValue ?? Object.is;
  let active: Promise<void> | undefined;
  let activeTask: PersistenceTask<Value> | undefined;
  let lastSuccess: { readonly result: Result; readonly value: Value } | undefined;
  let pending: PersistenceTask<Value> | undefined;
  let submittedSequence = 0;

  async function drain() {
    while (pending) {
      const task = pending;
      pending = undefined;
      activeTask = task;
      const requestStartedAt = now();
      try {
        const result = await options.save(task.value);
        const finishedAt = now();
        lastSuccess = { result, value: task.value };
        options.onSuccess?.({
          queueMs: Math.max(0, requestStartedAt - task.enqueuedAt),
          requestMs: Math.max(0, finishedAt - requestStartedAt),
          result,
          supersededCount: task.supersededCount,
          value: task.value,
        });
      } catch (error) {
        const finishedAt = now();
        options.onFailure?.({
          error,
          queueMs: Math.max(0, requestStartedAt - task.enqueuedAt),
          requestMs: Math.max(0, finishedAt - requestStartedAt),
          supersededCount: task.supersededCount,
          value: task.value,
        });
        if (task.sequence < submittedSequence) continue;
        throw error;
      } finally {
        activeTask = undefined;
      }
    }
  }

  function start() {
    if (active) return active;
    options.onPendingChange?.(true);
    const operation = drain();
    active = operation;
    void operation.finally(() => {
      active = undefined;
      if (pending) {
        void start().catch(() => undefined);
      } else {
        options.onPendingChange?.(false);
      }
    }).catch(() => undefined);
    return operation;
  }

  function submit(value: Value) {
    if (
      (activeTask && isSameValue(activeTask.value, value)) ||
      (pending && isSameValue(pending.value, value))
    ) return;
    submittedSequence += 1;
    pending = {
      enqueuedAt: now(),
      sequence: submittedSequence,
      supersededCount: pending ? pending.supersededCount + 1 : 0,
      value,
    };
    void start().catch(() => undefined);
  }

  async function flush(value: Value): Promise<Result> {
    if (
      (!lastSuccess || !isSameValue(lastSuccess.value, value)) &&
      (!activeTask || !isSameValue(activeTask.value, value)) &&
      (!pending || !isSameValue(pending.value, value))
    ) {
      submit(value);
    }
    while (
      !lastSuccess ||
      !isSameValue(lastSuccess.value, value)
    ) {
      const operation = active ?? start();
      await operation;
    }
    return lastSuccess.result;
  }

  async function settle() {
    while (active) await active.catch(() => undefined);
  }

  return { flush, settle, submit };
}
