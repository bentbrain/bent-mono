import assert from "node:assert/strict";
import { articles, chatKnowledge, home } from "../src/content/guide.ts";
import {
  changeGuideState,
  guideDocumentSchema,
} from "../src/lib/guide-cms-types.ts";

const document = guideDocumentSchema.parse({ home, articles, chatKnowledge });
const legacy = structuredClone(document);
delete legacy.home.intro;
const upgradedHome = guideDocumentSchema.parse(legacy).home;
assert.equal(
  upgradedHome.intro,
  home.intro,
  "Older CMS content gets the new introduction without losing host fields",
);
assert.equal(upgradedHome.hostPhone, legacy.home.hostPhone);
const blankIntro = structuredClone(document);
blankIntro.home.intro = "";
assert.equal(
  guideDocumentSchema.parse(blankIntro).home.intro,
  "",
  "Hosts can remove the introduction",
);

const directory = document.articles.find(
  (article) => article.id === "find-things",
);
assert.ok(directory);
assert.ok(directory.sections?.length);
assert.doesNotMatch(JSON.stringify(directory), /AI-only fixture note/i);
assert.match(JSON.stringify(document.chatKnowledge), /AI-only fixture note/i);
assert.match(JSON.stringify(document.chatKnowledge), /AI-only fixture note/i);

const initial = {
  version: 1,
  revision: "initial",
  published: document,
  draft: document,
  savedAt: null,
  publishedAt: null,
};
const draft = structuredClone(document);
draft.home.hostPhone = "draft phone number";
const saved = changeGuideState(
  initial,
  draft,
  "save",
  "draft-revision",
  "2026-10-12T00:00:00Z",
);
assert.deepEqual(
  saved.published,
  document,
  "Saving a draft must not change guest content",
);
assert.equal(saved.draft.home.hostPhone, "draft phone number");
assert.equal(saved.publishedAt, null);
const published = changeGuideState(
  saved,
  draft,
  "publish",
  "published-revision",
  "2026-10-12T00:01:00Z",
);
assert.deepEqual(published.published, draft);
assert.deepEqual(published.draft, draft);
assert.equal(published.publishedAt, "2026-10-12T00:01:00Z");
assert.deepEqual(
  initial.published,
  document,
  "Publishing must not mutate prior state",
);

const invalid = structuredClone(document);
invalid.articles.push(invalid.articles[0]);
assert.equal(
  guideDocumentSchema.safeParse(invalid).success,
  false,
  "Duplicate IDs must be rejected",
);
const unsupportedPhoto = structuredClone(document);
unsupportedPhoto.articles[0].image = {
  src: "https://example.com/tracker.jpg",
  alt: "photo",
  width: 100,
  height: 100,
};
assert.equal(
  guideDocumentSchema.safeParse(unsupportedPhoto).success,
  false,
  "Only curated photos may be used",
);
const unsafeLink = structuredClone(document);
unsafeLink.articles[0].links = [{ label: "link", href: "javascript:alert(1)" }];
assert.equal(
  guideDocumentSchema.safeParse(unsafeLink).success,
  false,
  "Executable links must be rejected",
);
console.log(
  "PASS: draft/publish separation, AI-only facts, immutable state and safe content validation",
);
