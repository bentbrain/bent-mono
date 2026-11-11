import { isDeepStrictEqual as equal } from "node:util";

const record = value => value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
function bindingsByName(bindings) {
  if (!Array.isArray(bindings)) return;
  const names = new Map();
  for (const binding of bindings) {
    if (!record(binding) || typeof binding.name !== "string" || binding.name.trim().length === 0 ||
      typeof binding.type !== "string" || binding.type.trim().length === 0 || names.has(binding.name)) return;
    names.set(binding.name, binding);
  }
  return names;
}

// Only the top-level named binding collection is unordered. Compare complete
// entries and every remaining setting without changing retained provider data.
export function equalWorkerSettings(actual, expected) {
  if (!record(actual) || !record(expected)) return false;
  const a = bindingsByName(actual.bindings), b = bindingsByName(expected.bindings);
  if (!a || !b || a.size !== b.size) return false;
  const { bindings: _a, ...restA } = actual, { bindings: _b, ...restB } = expected;
  return equal(restA, restB) && [...a].every(([name, binding]) => b.has(name) && equal(binding, b.get(name)));
}

// Completion snapshots retain their raw hash contract. Semantic comparison is
// restricted to these four full provider-settings fields, never recursive.
export function equalCompletionState(actual, expected) {
  if (!record(actual) || !record(expected)) return false;
  const keys = ["apiSettings", "executorSettings", "latestApiSettings", "latestExecutorSettings"];
  if (!keys.every(key => Object.hasOwn(actual, key) && Object.hasOwn(expected, key) && equalWorkerSettings(actual[key], expected[key]))) return false;
  const rest = value => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
  return equal(rest(actual), rest(expected));
}
