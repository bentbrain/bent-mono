// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CameraMobileRoute } from "@/components/camera-mobile-route";

const mocks = vi.hoisted(() => ({
  replace: vi.fn<(href: string) => void>(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
}));

vi.mock("@/components/camera-permission-launcher", () => ({
  CameraPermissionLauncher: ({
    onDraftCreated,
  }: {
    onDraftCreated: (designId: string) => void;
  }) => (
    <button onClick={() => { onDraftCreated("6f8df4a7-4672-475f-a412-e3b02383772f"); }}>
      Finish draft
    </button>
  ),
}));

vi.mock("@/components/mobile-only-gate", () => ({
  MobileOnlyGate: ({ children }: { children: React.ReactNode }) => children,
}));

afterEach(() => {
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe("CameraMobileRoute", () => {
  it("uses normal Next.js navigation after creating the draft", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => { root.render(<CameraMobileRoute />); });
    const finish = container.querySelector<HTMLButtonElement>("button");
    if (!finish) throw new Error("Expected the draft completion control.");
    act(() => { finish.click(); });

    expect(mocks.replace).toHaveBeenCalledWith(
      "/design/6f8df4a7-4672-475f-a412-e3b02383772f?camera=1",
    );
    act(() => { root.unmount(); });
  });
});
