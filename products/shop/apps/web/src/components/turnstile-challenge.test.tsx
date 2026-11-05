// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TurnstileChallenge } from "@/components/turnstile-challenge";

vi.mock("@/env", () => ({
  env: { NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA" },
}));

let options: Parameters<NonNullable<Window["turnstile"]>["render"]>[1] | undefined;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete window.bentTurnstileReady;
  delete window.turnstile;
  document.getElementById("turnstile-script")?.remove();
  document.body.replaceChildren();
  options = undefined;
});

describe("TurnstileChallenge", () => {
  it("renders when the Turnstile API loaded before the component mounted", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const render = vi.fn(() => "widget-1");
    window.turnstile = {
      remove: vi.fn(),
      reset: vi.fn(),
      render,
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<TurnstileChallenge onToken={vi.fn()} />);
      await Promise.resolve();
    });

    expect(render).toHaveBeenCalledOnce();
    act(() => { root.unmount(); });
  });

  it("renders after the Turnstile API invokes its documented ready callback", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let script: HTMLScriptElement | undefined;
    vi.spyOn(document.head, "append").mockImplementation((...nodes) => {
      const [node] = nodes;
      if (node instanceof HTMLScriptElement) script = node;
    });
    const render = vi.fn(() => "widget-1");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => { root.render(<TurnstileChallenge onToken={vi.fn()} />); });
    expect(render).not.toHaveBeenCalled();
    expect(script?.src).toBe(
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=bentTurnstileReady",
    );

    window.turnstile = {
      remove: vi.fn(),
      reset: vi.fn(),
      render,
    };
    const ready = window.bentTurnstileReady;
    if (!ready) throw new Error("Expected the Turnstile ready callback.");
    await act(async () => {
      ready();
      await Promise.resolve();
    });

    expect(render).toHaveBeenCalledOnce();
    act(() => { root.unmount(); });
  });

  it("announces failures and expiry and resets the widget accessibly", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const reset = vi.fn();
    window.turnstile = {
      remove: vi.fn(),
      reset,
      render(_container, nextOptions) {
        options = nextOptions;
        return "widget-1";
      },
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<TurnstileChallenge onToken={vi.fn()} />);
      await Promise.resolve();
    });
    if (!options) throw new Error("Expected Turnstile render options.");
    const renderedOptions = options;
    expect(renderedOptions.appearance).toBe("interaction-only");
    act(() => { renderedOptions["error-callback"](); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("security check failed");
    const retry = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent.includes("Retry security check"),
    );
    if (!retry) throw new Error("Expected a security retry control.");
    act(() => { retry.click(); });
    expect(reset).toHaveBeenCalledWith("widget-1");
    act(() => { renderedOptions["expired-callback"](); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("security check expired");
    act(() => { root.unmount(); });
  });

  it("provides a retry when the Turnstile script fails to load", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let script: HTMLScriptElement | undefined;
    vi.spyOn(document.head, "append").mockImplementation((...nodes) => {
      const [node] = nodes;
      if (node instanceof HTMLScriptElement) script = node;
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => { root.render(<TurnstileChallenge onToken={vi.fn()} />); });
    if (!script) throw new Error("Expected the Turnstile script.");
    const appendedScript = script;
    await act(async () => {
      appendedScript.dispatchEvent(new Event("error"));
      await Promise.resolve();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("could not load");
    expect(container.textContent).toContain("Retry security check");
    act(() => { root.unmount(); });
  });

  it("provides a retry when the Turnstile script does not finish loading", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(document.head, "append").mockImplementation(() => undefined);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => { root.render(<TurnstileChallenge onToken={vi.fn()} />); });

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("could not load");
    expect(container.textContent).toContain("Retry security check");
    act(() => { root.unmount(); });
  });
});
