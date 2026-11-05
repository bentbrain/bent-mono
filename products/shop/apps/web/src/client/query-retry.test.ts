import { describe, expect, it } from "vitest";

import { retryServerMutation } from "./query-retry";

describe("server mutation retry policy", () => {
  it("does not replay an explicitly non-retryable mutation", () => {
    expect(retryServerMutation(0, { retryable: false })).toBe(false);
  });

  it("retains bounded retries for ordinary transient failures", () => {
    expect(retryServerMutation(0, new Error("Temporary failure"))).toBe(true);
    expect(retryServerMutation(3, new Error("Temporary failure"))).toBe(false);
  });
});
