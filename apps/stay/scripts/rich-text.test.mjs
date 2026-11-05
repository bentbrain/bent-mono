import assert from "node:assert/strict";
import { getSchema } from "@tiptap/core";
import { richEditorExtensions } from "../src/lib/rich-editor-extensions.ts";
import { readFileSync } from "node:fs";
import { articles, chatKnowledge, home } from "../src/content/guide.ts";
import { guideDocumentSchema } from "../src/lib/guide-cms-types.ts";
import { upgradeGuideDocument } from "../src/lib/guide-migration.ts";
import {
  richDocumentSchema,
  richText,
  isGuideLink,
  youtubeId,
} from "../src/lib/rich-text.ts";
import { wifiQrValue } from "../src/lib/wifi-qr.ts";
import { localHomeControlsUrl } from "../src/lib/home-control-link.ts";
assert.equal(isGuideLink(localHomeControlsUrl), true);
for (const url of [
  "http://example.com/",
  "http://192.0.2.10:8123/",
  localHomeControlsUrl + "?entity_id=lock.front_door",
  "http://user:password@192.0.2.11:18232/",
])
  assert.equal(isGuideLink(url), false);
const original = guideDocumentSchema.parse({ home, articles, chatKnowledge });
const before = structuredClone(original);
const migrated = guideDocumentSchema.parse(upgradeGuideDocument(original));
assert.deepEqual(original, before, "Migration must not mutate stored content");
assert.deepEqual(
  upgradeGuideDocument(migrated),
  migrated,
  "Migration must be idempotent and preserve rich edits",
);
for (const article of original.articles) {
  const upgraded = migrated.articles.find((item) => item.id === article.id);
  assert.ok(upgraded);
  for (const text of [...article.paragraphs, ...(article.steps ?? [])])
    assert.ok(richText(upgraded.body).includes(text));
}
const hostEdit = structuredClone(migrated);
hostEdit.articles[0].body.content.push({
  type: "paragraph",
  content: [{ type: "text", text: "A saved host edit" }],
});
assert.deepEqual(upgradeGuideDocument(hostEdit), hostEdit);
assert.equal(youtubeId("https://youtu.be/JUhZYxzUTqE"), "JUhZYxzUTqE");
assert.equal(
  youtubeId("https://youtube.com.evil.test/watch?v=JUhZYxzUTqE"),
  null,
);
assert.equal(
  richDocumentSchema.safeParse({
    type: "doc",
    content: [{ type: "youtube", attrs: { src: "javascript:alert(1)" } }],
  }).success,
  false,
);
assert.equal(
  richDocumentSchema.safeParse({
    type: "doc",
    content: [{ type: "image", attrs: { src: "https://example.com/tracker" } }],
  }).success,
  false,
);
assert.equal(
  richDocumentSchema.safeParse({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "bad",
            marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
          },
        ],
      },
    ],
  }).success,
  false,
);
assert.equal(
  wifiQrValue("A;B: C", "pass\\word;test"),
  "WIFI:T:WPA;S:A\\;B\\: C;P:pass\\\\word\\;test;;",
);
const guestSource = readFileSync("src/components/article-content.tsx", "utf8");
assert.doesNotMatch(guestSource, /article\.source|<summary[^>]*>source/);
console.log(
  "PASS: rich content migration, host edit preservation, safe embeds and Wi-Fi escaping",
);

const editorSchema = getSchema(richEditorExtensions());
for (const article of migrated.articles) {
  const roundTrip = editorSchema.nodeFromJSON(article.body).toJSON();
  assert.equal(
    richDocumentSchema.safeParse(roundTrip).success,
    true,
    `Editor output rejected for ${article.id}`,
  );
}
console.log(
  "PASS: every migrated topic round-trips through the actual editor schema",
);
