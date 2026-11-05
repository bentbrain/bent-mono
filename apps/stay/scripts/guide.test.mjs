import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { articles } from "../src/content/guide.ts";

for (const article of articles.filter((item) => item.status === "ready")) {
  for (const link of article.links ?? [])
    assert.ok(
      !/^\/(building|parking)(\/|\?|$)/.test(link.href),
      `${article.id} still links to a removed map or journey: ${link.href}`,
    );
  assert.ok(
    !/parking (map|plan)|3d|the model shows/i.test(
      [article.summary, ...article.paragraphs, ...(article.steps ?? [])].join(
        " ",
      ),
    ),
    `${article.id} still depends on a generated map`,
  );
}
for (const file of [
  "src/app/building/page.tsx",
  "src/app/parking/page.tsx",
  "src/app/parking/plan.svg/route.ts",
  "src/components/building-three.tsx",
  "src/components/building-viewer.tsx",
  "src/components/parking-viewer.tsx",
])
  assert.equal(
    existsSync(file),
    false,
    `Old map implementation remains: ${file}`,
  );
console.log(
  "PASS: guide instructions have no generated maps or nested journeys",
);
