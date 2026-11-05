import assert from "node:assert/strict";
import {
  isGuideFixtureEnvironment,
  normalizeGuideLinks,
} from "../src/lib/guide-content-policy.ts";

assert.equal(
  isGuideFixtureEnvironment({
    NODE_ENV: "production",
    VERCEL_ENV: "production",
  }),
  false,
);
assert.equal(isGuideFixtureEnvironment({ NODE_ENV: "production" }), false);
assert.equal(
  isGuideFixtureEnvironment({ NODE_ENV: "production", VERCEL_ENV: "preview" }),
  true,
);
assert.equal(isGuideFixtureEnvironment({ NODE_ENV: "development" }), true);
assert.equal(
  isGuideFixtureEnvironment({
    NODE_ENV: "development",
    VERCEL_ENV: "production",
  }),
  false,
);
const original = {
  articles: [
    {
      links: [{ href: "http://controls.example.invalid/", label: "Controls" }],
    },
  ],
  notes: "Preserve other host content",
};
const snapshot = structuredClone(original);
assert.deepEqual(normalizeGuideLinks(original), original);
assert.deepEqual(
  normalizeGuideLinks(original, "http://controls.example.invalid/"),
  {
    articles: [{ links: [{ href: "/home-controls", label: "Controls" }] }],
    notes: "Preserve other host content",
  },
);
assert.deepEqual(original, snapshot);
console.log(
  "PASS: production fixture exclusion and exact legacy-link normalization preserve private CMS data",
);
