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
};

let bridge: Bridge | undefined;

/** One bridge per page. It asks the person before any step on a control marked `data-agent-confirm`. */
function browserBridge(): Bridge {
  if (bridge) return bridge;
  const ask = createConfirm<Request>();
  const agent = createAgent({
    allow: (step, { signal }) => {
      if (!step.confirm) return true;
      signal.addEventListener("abort", () => ask.controller.close(), {
        once: true,
      });
      return ask({ action: step.confirm });
    },
  });
  bridge = { agent, ask };
  return bridge;
}

/**
 * Lets a browser agent read and use the signed-in app through WebMCP. Every
 * step on a marked control waits for the person to answer in this dialog.
 */
export function AgentBridge() {
  const [ask, setAsk] = useState<Bridge["ask"]>();
  useEffect(() => {
    const { agent, ask } = browserBridge();
    setAsk(() => ask);
    // The bridge's own allow already asks the person, so this one doesn't ask twice.
    return registerTools(agent, { allow: () => true });
  }, []);
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
