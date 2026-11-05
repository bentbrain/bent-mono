import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const customerCopyFiles = [
  "privacy/page.tsx",
  "terms/page.tsx",
  "shipping/page.tsx",
  "returns/page.tsx",
  "content-rules/page.tsx",
  "contact/page.tsx",
];

describe("customer policy language", () => {
  it("keeps internal providers and obsolete launch language out of policies", async () => {
    const copy = await Promise.all(
      customerCopyFiles.map((file) =>
        readFile(new URL(file, import.meta.url), "utf8")
      ),
    );
    const policies = copy.join("\n");

    expect(policies).not.toMatch(/Bent Shirt|Pilot|customer accounts/i);
    expect(policies).not.toMatch(
      /OpenAI|Printify|The Print Bar|Cloudflare|Shopify|PostHog|Vercel/,
    );
    expect(policies).not.toContain("two business days");
    expect(policies).not.toMatch(/standard (delivery|shipping)/i);
    expect(policies).toContain("bent.shop");
  });
});
