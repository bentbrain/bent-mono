import assert from "node:assert/strict";
import test from "node:test";
import { equalWorkerSettings, equalCompletionState } from "./native-worker-settings.mjs";

const settings = () => ({ migration_tag: "synthetic-v1", compatibility_date: "2026-08-12", usage_model: "standard",
  compatibility_flags: ["nodejs_compat", "synthetic-flag"], bindings: Array.from({ length: 52 }, (_, i) =>
    i < 4 ? { name: `SECRET_${i}`, type: "secret_text", metadata: { version: i, sequence: [1, 2] } } :
      { name: `SETTING_${i}`, type: "plain_text", text: `synthetic-${i}`, unknown: { sequence: [1, 2] } }) });
function shuffle(value, seed) {
  const next = structuredClone(value);
  for (let i = next.bindings.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [next.bindings[i], next.bindings[j]] = [next.bindings[j], next.bindings[i]];
  }
  return next;
}
test("full settings accept 1000 deterministic binding permutations and retain original raw bytes", () => {
  const expected = settings(), bytes = JSON.stringify(expected);
  for (let seed = 0; seed < 1000; seed++) {
    const actual = shuffle(expected, seed), raw = JSON.stringify(actual);
    assert.equal(equalWorkerSettings(actual, expected), true);
    assert.equal(JSON.stringify(actual), raw);
  }
  assert.equal(JSON.stringify(expected), bytes);
});
test("full settings fail closed on malformed, duplicate, missing, extra, case, metadata and nested-array changes", () => {
  const expected = settings();
  for (const mutate of [
    x => { x.bindings = {}; }, x => { delete x.bindings; }, x => { x.bindings[0] = null; }, x => { x.bindings[0] = []; },
    x => { delete x.bindings[0].name; }, x => { x.bindings[0].name = 1; }, x => { x.bindings[0].name = ""; }, x => { x.bindings[0].name = "  "; },
    x => { x.bindings[0].name = "secret_0"; }, x => { x.bindings[0].type = ""; }, x => { delete x.bindings[0].type; },
    x => x.bindings.push(structuredClone(x.bindings[0])), x => x.bindings.pop(), x => x.bindings.push({ name: "EXTRA", type: "images" }),
    x => { x.bindings[0].type = "plain_text"; }, x => { x.bindings[0].metadata.version++; }, x => { x.bindings[4].text = "changed"; },
    x => { x.bindings[0].metadata.sequence.reverse(); }, x => { x.bindings[4].unknown.sequence.reverse(); },
    x => { x.compatibility_flags.reverse(); }, x => { x.usage_model = "changed"; }, x => { x.extra = true; },
  ]) {
    const actual = settings(); mutate(actual);
    assert.equal(equalWorkerSettings(actual, expected), false);
    assert.equal(equalWorkerSettings(expected, actual), false);
  }
  for (const malformed of [undefined, null, [], {}, 1]) assert.equal(equalWorkerSettings(malformed, malformed), false);
  const duplicate = settings(); duplicate.bindings.push(duplicate.bindings[0]);
  assert.equal(equalWorkerSettings(duplicate, duplicate), false);
});
test("complete state comparison permits only four top-level settings collections to reorder", () => {
  const state = { schemaVersion: 1, apiSettings: settings(), executorSettings: settings(), latestApiSettings: settings(), latestExecutorSettings: settings(),
    journals: { failed: [{ stage: "first" }, { stage: "second" }] }, uploads: { metadata: { bindings: [1, 2] } }, control: { paused: 1 } };
  for (const key of ["apiSettings", "executorSettings", "latestApiSettings", "latestExecutorSettings"]) {
    assert.equal(equalCompletionState({ ...state, [key]: shuffle(state[key], 21) }, state), true);
  }
  for (const mutate of [x => x.journals.failed.reverse(), x => x.uploads.metadata.bindings.reverse(), x => { x.control.paused = 0; },
    x => { x.apiSettings.bindings.pop(); }, x => { delete x.executorSettings; }, x => { x.extra = true; }]) {
    const actual = structuredClone(state); mutate(actual);
    assert.equal(equalCompletionState(actual, state), false);
  }
});
