import { pathToFileURL } from "node:url";

export function verifyDispatchSource(env = process.env) {
  const expected = env.RELEASE_EXPECTED_SOURCE ?? "", coordination = env.RELEASE_COORDINATION_ID ?? "";
  if (expected && (!/^[a-f0-9]{40}$/.test(expected) || env.GITHUB_SHA !== expected || env.GITHUB_REF !== "refs/heads/main")) {
    throw Error("Dispatched source differs from the pinned main commit; no release may start.");
  }
  if (coordination && (!/^release-[a-f0-9-]{36}-[0-9]+$/.test(coordination) || !expected ||
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" || env.GITHUB_RUN_ATTEMPT !== "1")) {
    throw Error("Coordinated releases require a pinned first-attempt dispatch; use recorded recovery after interruption.");
  }
}
// This guard runs before setup-node, so support the runner's system Node too.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) verifyDispatchSource();
