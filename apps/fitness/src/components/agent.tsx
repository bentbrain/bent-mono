import { useEffect, useState } from "react";
import { createAgent, registerTools } from "@ui-sdk/react/agent";
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
type Bridge = {
  agent: ReturnType<typeof createAgent>;
  ask: ReturnType<typeof createConfirm<Request>>;
  end: () => void;
};

/**
 * A bridge for one signed-in account. Once it ends, every step it still has,
 * including ones queued behind a question, is refused. A step on a control
 * marked `data-agent-confirm` waits for the person to allow it.
 */
function createBridge(): Bridge {
  const ask = createConfirm<Request>();
  let live = true;
  const agent = createAgent({
    allow: async (step, { signal }) => {
      if (!live) return false;
      if (!step.confirm) return true;
      // A native modal dialog makes the question underneath it unanswerable.
      if (document.querySelector("dialog:modal")) return false;
      signal.addEventListener("abort", () => ask.controller.close(), {
        once: true,
      });
      return (await ask({ action: step.confirm })) && live;
    },
  });
  return {
    agent,
    ask,
    end: () => {
      live = false;
      ask.controller.close();
    },
  };
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
    // Runs after the dialog below has mounted, so a first call can ask. The
    // bridge's own allow already asks the person, so this one doesn't ask twice.
    return registerTools(bridge.agent, { allow: () => true });
  }, [bridge]);
  if (!bridge) return null;
  const { ask } = bridge;
  if (!ask) return null;
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
