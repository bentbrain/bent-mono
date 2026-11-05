import { afterEach, expect, it, vi } from "vitest";
import { shippingQualificationOptions } from "./shipping-qualification-platform";
afterEach(() => vi.unstubAllEnvs());
it("uses local disposable bindings unless the guarded cloud runner requests remote qualification", async () => {
  vi.stubEnv("NATIVE_SHIPPING_QUALIFICATION_CONFIG", "");
  expect(await shippingQualificationOptions()).toEqual({options:{environment:"",persist:false,remoteBindings:false},remote:false});
});
it("rejects a remote database request outside the personal Actions qualification before reading its config", async () => {
  vi.stubEnv("NATIVE_SHIPPING_QUALIFICATION_CONFIG", "/private/not-read/wrangler.json");
  vi.stubEnv("GITHUB_ACTIONS", "false");
  await expect(shippingQualificationOptions()).rejects.toThrow("guarded personal Actions context");
});
