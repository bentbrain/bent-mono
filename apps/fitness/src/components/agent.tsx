import { useEffect, useState } from "react";
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
type Tools = Record<string, (input: unknown) => Promise<unknown>>;
type Bridge = {
  tools: Tools;
  ask: ReturnType<typeof createConfirm<Request>>;
  end: () => void;
};
type ModelContext = {
  registerTool?: (
    tool: (typeof agentTools)[number] & {
      annotations: Record<string, boolean>;
      execute: (input: unknown) => Promise<unknown>;
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
const actInput = z.object({
  steps: z.array(
    z.object({
      ref: z.string(),
      action: z.string(),
      args: z.array(z.unknown()).optional(),
    }),
  ),
});
const queryInput = z.object({
  text: z.string().optional(),
  within: z.string().optional(),
  kind: z.string().optional(),
  closed: z.boolean().optional(),
  from: z.number().optional(),
});
const hints: Record<string, Record<string, boolean>> = {
  snapshot: { readOnlyHint: true, untrustedContentHint: true },
  query: { untrustedContentHint: true },
  act: { consequentialHint: true, untrustedContentHint: true },
};

/**
 * The agent tools for one signed-in account. Once it ends, they read nothing,
 * return nothing from the page and refuse every step they still have,
 * including ones waiting on a question. A step on a control marked
 * `data-agent-confirm` waits for the person to allow it.
 */
function createBridge(): Bridge {
  const ask = createConfirm<Request>();
  const lifetime = new AbortController();
  const live = () => !lifetime.signal.aborted;
  const agent = createAgent({
    allow: async (step, { signal }) => {
      if (!live()) return false;
      if (!step.confirm) return true;
      // A native modal dialog makes the question underneath it unanswerable.
      if (document.querySelector("dialog:modal")) return false;
      signal.addEventListener("abort", () => ask.controller.close(), {
        once: true,
      });
      return (await ask({ action: step.confirm })) && live();
    },
  });
  const refused = {
    ok: false,
    error: { step: 0, message: closed },
    steps: [],
    appeared: [],
    values: {},
  };
  const tools: Tools = {
    snapshot: async () => (live() ? agent.snapshot() : []),
    query: async (input) => {
      const request = queryInput.safeParse(input ?? {});
      if (!request.success) return { error: "Send query input as JSON." };
      if (!live()) return { error: closed };
      const found = await agent.query(request.data);
      return live() ? found : { error: closed };
    },
    act: async (input) => {
      const request = actInput.safeParse(input);
      if (!request.success)
        return { ...refused, error: { step: 0, message: "Send steps." } };
      if (!live()) return refused;
      const result = await agent.act(request.data, {
        signal: lifetime.signal,
      });
      return live() ? result : refused;
    },
  };
  return {
    tools,
    ask,
    end: () => {
      lifetime.abort();
      ask.controller.close();
    },
  };
}

/** Registers the tools with the browser's WebMCP until `signal` aborts. */
function registerBrowserTools(tools: Tools, signal: AbortSignal) {
  const context = document.modelContext;
  if (typeof context?.registerTool !== "function") return;
  for (const tool of agentTools) {
    const execute = tools[tool.name];
    if (!execute) continue;
    void Promise.resolve(
      context.registerTool(
        { ...tool, annotations: hints[tool.name] ?? {}, execute },
        { signal },
      ),
    ).catch(() => undefined);
  }
}

/**
 * Lets a browser agent read and use the signed-in app through WebMCP while
 * this account is open. Every step on a marked control waits for the person
 * to answer in this dialog.
 */
export function AgentBridge() {
  const [bridge, setBridge] = useState<Bridge>();
  useEffect(() => {
    const next = createBridge();
    setBridge(next);
    return next.end;
  }, []);
  useEffect(() => {
    if (!bridge) return;
    // Runs after the dialog below has mounted, so a first call can ask.
    const registration = new AbortController();
    registerBrowserTools(bridge.tools, registration.signal);
    return () => registration.abort();
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
