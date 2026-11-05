import { readQualificationRun } from "./native-qualification-reference.mjs";
import { developmentOperation } from "./native-ci-operation.mjs";
import { createDevelopmentReleaseStore } from "./native-ci-release-store.mjs";
import { verifyDevelopmentQualification } from "./native-production-qualification.mjs";

export async function verifySavedDevelopmentQualification(receipt, env = process.env,
  { request = fetch, createStore = createDevelopmentReleaseStore } = {}) {
  if (developmentOperation(env) !== "verify-qualification" || !env.GITHUB_TOKEN || receipt?.schemaVersion !== 1 ||
    !Number.isSafeInteger(receipt.qualificationRunId) || receipt.qualificationRunId <= 0 ||
    receipt.expectedPair?.releaseId !== env.NATIVE_VERIFY_RELEASE) throw new Error("Saved qualification verification requires the explicit pinned Development release.");
  const response = await request(`https://api.github.com/repos/bentbrain/bent-mono/actions/runs/${receipt.qualificationRunId}`, {
    redirect: "error", signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!response.ok) throw new Error("Could not confirm the original qualification workflow; response content was not logged.");
  const githubRun = await response.json();
  if (githubRun.id !== receipt.qualificationRunId) throw new Error("Original qualification run identity mismatch.");
  const store = await createStore(env);
  const result = await verifyDevelopmentQualification({ reference: receipt.reference, expectedPair: receipt.expectedPair,
    expectedQualificationCommit: receipt.expectedQualificationCommit, githubRun, readObject: store.read, readRun: id => readQualificationRun(env,id,request) });
  return { ...result, applicationMutations: false };
}
