const TURNSTILE_CALLBACK_NAME = "bentTurnstileReady";
const TURNSTILE_SCRIPT_ID = "turnstile-script";

const TURNSTILE_LOAD_TIMEOUT_MS = 10_000;

interface TurnstileRenderOptions {
  readonly action: string;
  readonly appearance: "interaction-only";
  readonly callback: (token: string) => void;
  readonly "error-callback": () => void;
  readonly "expired-callback": () => void;
  readonly sitekey: string;
  readonly theme: "auto";
}

export interface TurnstileApi {
  remove(widgetId: string): void;
  reset(widgetId: string): void;
  render(container: HTMLElement, options: TurnstileRenderOptions): string;
}

declare global {
  interface Window {
    bentTurnstileReady?: () => void;
    turnstile?: TurnstileApi;
  }
}

let pendingLoad: Promise<TurnstileApi> | undefined;

export function loadTurnstile(): Promise<TurnstileApi> {
  const available = window.turnstile;
  if (available) return Promise.resolve(available);
  if (pendingLoad) return pendingLoad;

  document.getElementById(TURNSTILE_SCRIPT_ID)?.remove();

  pendingLoad = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    let settled = false;

    const clearLoadState = () => {
      window.clearTimeout(timeoutId);
      script.removeEventListener("error", handleError);
      if (window.bentTurnstileReady === handleReady) {
        delete window.bentTurnstileReady;
      }
      pendingLoad = undefined;
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearLoadState();
      script.remove();
      reject(new Error(message));
    };
    const handleReady = () => {
      const turnstile = window.turnstile;
      if (!turnstile) {
        fail("The security check API was unavailable after loading.");
        return;
      }
      if (settled) return;
      settled = true;
      clearLoadState();
      resolve(turnstile);
    };
    const handleError = () => {
      fail("The security check script could not load.");
    };
    const timeoutId = window.setTimeout(() => {
      fail("The security check script took too long to load.");
    }, TURNSTILE_LOAD_TIMEOUT_MS);

    window.bentTurnstileReady = handleReady;
    script.id = TURNSTILE_SCRIPT_ID;
    script.src = `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=${TURNSTILE_CALLBACK_NAME}`;
    script.async = true;
    script.defer = true;
    script.addEventListener("error", handleError, { once: true });
    document.head.append(script);
  });

  return pendingLoad;
}
