import { useEffect, useInsertionEffect, useRef, useState } from "react";
import { z } from "zod";
import { agentTools, createAgent } from "@ui-sdk/react/agent";
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  createConfirm,
} from "@ui-sdk/react/alert-dialog";

type Request = { action: string };
type Execute = (input: unknown, options?: unknown) => Promise<unknown>;
type Tools = Record<string, Execute>;
type Bridge = {
  tools: Tools;
  ask: ReturnType<typeof createConfirm<Request>>;
  lifetime: AbortSignal;
  end: () => void;
  /** The suffix of the bridge's tool names, once registered. */
  id?: string;
};
type ModelContext = {
  registerTool?: (
    tool: (typeof agentTools)[number] & {
      annotations: Record<string, boolean>;
      execute: Execute;
    },
    options: { signal: AbortSignal },
  ) => unknown;
};
declare global {
  interface Document {
    /** WebMCP, in browsers that provide it. */
    modelContext?: ModelContext;
  }
}

const closed =
  "This Fitness account is no longer open. Ask the person to open it again.";
const actInput = z.strictObject({
  steps: z.array(
    z.strictObject({
      ref: z.string(),
      action: z.string(),
      args: z.array(z.unknown()).optional(),
    }),
  ),
});
const queryInput = z.strictObject({
  text: z.string().optional(),
  within: z.string().optional(),
  kind: z.string().optional(),
  closed: z.boolean().optional(),
  from: z.number().optional(),
});
const invocation = z.object({ signal: z.instanceof(AbortSignal).optional() });
const hints: Record<string, Record<string, boolean>> = {
  snapshot: { readOnlyHint: true, untrustedContentHint: true },
  query: { untrustedContentHint: true },
  act: { consequentialHint: true, untrustedContentHint: true },
};

function invalid(error: z.ZodError, takes: string) {
  return error.issues
    .map((issue) =>
      issue.code === "unrecognized_keys"
        ? `${["input", ...issue.path].join(".")} doesn't take ${issue.keys.join(", ")}. ${takes}`
        : `${["input", ...issue.path].join(".")}: ${issue.message}`,
    )
    .join(" ");
}
const actTakes = "A step takes ref, action and args; put values in args.";
const queryTakes = "A query takes text, within, kind, closed and from.";

/** The step a validation error is about, or 0 for the call itself. */
function failedStep(error: z.ZodError) {
  const [field, index] = error.issues[0]?.path ?? [];
  return field === "steps" && typeof index === "number" ? index : 0;
}

/** A signal that aborts when either one does, without `AbortSignal.any`. */
function either(first: AbortSignal, second: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const release = () => {
    first.removeEventListener("abort", abort);
    second.removeEventListener("abort", abort);
  };
  if (first.aborted || second.aborted) controller.abort();
  else {
    first.addEventListener("abort", abort, { once: true });
    second.addEventListener("abort", abort, { once: true });
  }
  return { signal: controller.signal, release };
}

/**
 * The agent tools for one signed-in account. Calls run one at a time, and
 * each checks the account is still open before it reads the page. Once the
 * account ends, they read nothing, return nothing from the page and refuse
 * every step they still have, including ones waiting on a question. A step
 * on a control marked `data-agent-confirm` waits for the person to allow it.
 */
function createBridge(): Bridge {
  const ask = createConfirm<Request>();
  // Closing the dialog updates React, so it waits until any commit that
  // ended the account has finished.
  const closeLater = () => queueMicrotask(() => ask.controller.close());
  const lifetime = new AbortController();
  const live = () => !lifetime.signal.aborted;
  const agent = createAgent({
    allow: async (step, { signal }) => {
      if (!live()) return false;
      if (!step.confirm) return true;
      // A native modal dialog makes the question underneath it unanswerable.
      if (document.querySelector("dialog:modal")) return false;
      signal.addEventListener("abort", closeLater, { once: true });
      return (await ask({ action: step.confirm })) && live();
    },
  });
  const refused = (message = closed, step = 0) => ({
    ok: false,
    error: { step, message },
    steps: [],
    appeared: [],
    values: {},
  });
  let queue: Promise<unknown> = Promise.resolve();
  const inTurn = <T,>(task: () => Promise<T>) => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };
  const tools: Tools = {
    snapshot: async () => (live() ? agent.snapshot() : []),
    query: (input) => {
      const request = queryInput.safeParse(input ?? {});
      if (!request.success)
        return Promise.resolve({ error: invalid(request.error, queryTakes) });
      return inTurn(async () => {
        if (!live()) return { error: closed };
        const found = await agent.query(request.data);
        return live() ? found : { error: closed };
      });
    },
    act: (input, options) => {
      const request = actInput.safeParse(input);
      if (!request.success)
        return Promise.resolve(
          refused(invalid(request.error, actTakes), failedStep(request.error)),
        );
      const caller = invocation.safeParse(options ?? {});
      const cancel = caller.success ? caller.data.signal : undefined;
      const { signal, release } = cancel
        ? either(cancel, lifetime.signal)
        : { signal: lifetime.signal, release: () => undefined };
      let started = false;
      let stopWaiting: () => void = () => undefined;
      const run = inTurn(async () => {
        started = true;
        stopWaiting();
        if (!live()) return refused();
        const result = await agent.act(request.data, { signal });
        return live() ? result : refused();
      }).finally(release);
      if (!cancel) return run;
      // A call still queued behind another reports its cancellation at once.
      // Once it runs, the bridge reports which steps finished.
      const queued = new Promise((resolve) => {
        const settle = () => {
          if (!started) resolve(refused("The call was cancelled."));
        };
        if (cancel.aborted) return settle();
        cancel.addEventListener("abort", settle, { once: true });
        stopWaiting = () => cancel.removeEventListener("abort", settle);
      });
      return Promise.race([run, queued]);
    },
  };
  return {
    tools,
    ask,
    lifetime: lifetime.signal,
    end: () => {
      lifetime.abort();
      closeLater();
    },
  };
}

/**
 * Registers the tools with the browser's WebMCP until `signal` aborts. A
 * browser can keep a tool by name across registrations and page loads in a
 * tab, so every registration gets names of its own, and an earlier handle,
 * like one from another account, can't reach it.
 */
function registerBrowserTools(bridge: Bridge, signal: AbortSignal) {
  const context = document.modelContext;
  if (typeof context?.registerTool !== "function" || signal.aborted) return;
  const id = (bridge.id ??= crypto.randomUUID().slice(0, 8));
  for (const tool of agentTools) {
    const execute = bridge.tools[tool.name];
    if (!execute) continue;
    const name = `${tool.name}_${id}`;
    try {
      void Promise.resolve(
        context.registerTool(
          { ...tool, name, annotations: hints[tool.name] ?? {}, execute },
          { signal },
        ),
      ).catch(() => undefined);
    } catch {
      // A browser that refuses one tool still gets the others.
    }
  }
}

/**
 * Lets a browser agent read and use the signed-in app through WebMCP while
 * this account is open. Every step on a marked control waits for the person
 * to answer in this dialog.
 */
export function AgentBridge() {
  const [bridge, setBridge] = useState<Bridge>();
  const current = useRef<Bridge>(undefined);
  useEffect(() => {
    const next = createBridge();
    current.current = next;
    setBridge(next);
    return next.end;
  }, []);
  // Ends the tools as React removes the account, before the next account's
  // screen is on the page. Unlike a layout effect, it doesn't run while a
  // Suspense boundary only hides this screen.
  useInsertionEffect(() => () => current.current?.end(), []);
  useEffect(() => {
    if (!bridge) return;
    // Runs after the dialog below has mounted, so a first call can ask.
    const registration = new AbortController();
    const { signal, release } = either(registration.signal, bridge.lifetime);
    registerBrowserTools(bridge, signal);
    return () => {
      registration.abort();
      release();
    };
  }, [bridge]);
  if (!bridge) return null;
  const { ask } = bridge;
  return (
    <AlertDialog controller={ask.controller}>
      <AlertDialogBackdrop className="agent-confirm-backdrop" />
      <AlertDialogContent<Request>
        className="agent-confirm"
        data-agent-hidden
        data-feedback-private
      >
        {(state) => (
          <>
            <AlertDialogTitle>
              Allow your assistant to do this?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {state.payload?.action}
            </AlertDialogDescription>
            <div className="agent-confirm-actions">
              <AlertDialogClose className="bent-button bent-button--outline">
                Not now
              </AlertDialogClose>
              <AlertDialogClose
                className="bent-button bent-button--primary"
                value="confirm"
              >
                Allow
              </AlertDialogClose>
            </div>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
