import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { syntheticEvidenceDocuments } from "./synthetic-evidence.mjs";
import { parsePromotionInput } from "./release-promotion-input.mjs";
import { verifyPromotionEvidence } from "./native-production-candidate.mjs";

test("synthetic evidence passes the existing pair, immutable reference and acceptance guards", () => {
  const { evidence_1: candidateReceipt, evidence_2: qualification, evidence_3: manifest, evidence_4: phone, evidence_5: delivery } = syntheticEvidenceDocuments;
  const fixtures = JSON.parse(readFileSync(new URL("./protected-config.fixtures.json", import.meta.url), "utf8"));
  for (const [key, document] of Object.entries(syntheticEvidenceDocuments)) assert.deepEqual(JSON.parse(fixtures[key]), document);
  const sourceCommit = qualification.expectedQualificationCommit;
  const input = { schemaVersion: 1, sourceCommit, candidateReceipt, qualification, manifest, phone };
  assert.deepEqual(parsePromotionInput(JSON.stringify(input), sourceCommit), input);
  const candidate = { ...manifest.candidate, githubRunId: String(manifest.candidate.buildRunId) };
  const qualified = { ...qualification.expectedPair, qualificationRunId: qualification.qualificationRunId, cloudQualificationVerified: true };
  const buildRun = { id: manifest.candidate.buildRunId, head_sha: candidate.sourceCommit, head_branch: "main", path: ".github/workflows/native-development.yml" };
  const deliveryRun = { id: delivery.verificationRunId, head_sha: delivery.verificationSourceCommit, head_branch: "main", path: ".github/workflows/native-production-foundation.yml" };
  assert.equal(verifyPromotionEvidence(candidate, qualified, phone, delivery, buildRun, deliveryRun, manifest).productionAdmissionGranted, false);
});
