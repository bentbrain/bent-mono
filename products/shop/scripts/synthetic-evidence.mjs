import { createHash } from "node:crypto";

// Public test data only. These records do not describe or qualify a deployment.
const digest = (label, algorithm = "sha256") => createHash(algorithm).update(`synthetic fixture: ${label}`).digest("hex");
const sourceDigest = digest("candidate source manifest");
const sourceCommit = digest("candidate source commit", "sha1");
const qualificationCommit = digest("qualification source commit", "sha1");
const imageDigest = `sha256:${digest("renderer image")}`;
const buildRunId = 80000000013;
const qualificationRunId = 80000000901;
const alertRunId = 80000000062;
const alertCommit = digest("alert verification commit", "sha1");
const releaseId = `native-${qualificationRunId}`;
const workerVersionId = "00000000-0000-4000-8000-000000000901";
const ownerResponse = "Synthetic owner acceptance for fixture validation only.";
const requestedChecks = ["synthetic upload check", "synthetic preview check", "synthetic rendering check", "synthetic cart check", "synthetic navigation check", "synthetic notification check"];
const phonePath = "docs/synthetic-phone-acceptance.json";
const alertPath = "docs/synthetic-alert-delivery.json";

export const syntheticEvidenceDocuments = {
  evidence_1: {
    schemaVersion: 1,
    sourceDigest,
    candidateKey: `source/candidates/${sourceDigest}/${buildRunId}.json`,
    candidateVersion: "synthetic-candidate-object-version",
    candidateSha256: digest("candidate object bytes"),
  },
  evidence_2: {
    schemaVersion: 1,
    qualificationRunId,
    expectedQualificationCommit: qualificationCommit,
    expectedPair: { releaseId, sourceCommit: qualificationCommit, imageDigest },
    reference: {
      key: `source/releases/native-80000000041/qualification-receipt-${releaseId}-run-${qualificationRunId}.json`,
      version: "synthetic-qualification-object-version",
      sha256: digest("qualification object bytes"),
    },
  },
  evidence_3: {
    schemaVersion: 1,
    candidate: { sourceDigest, imageDigest, buildRunId, sourceCommit },
    qualification: { releaseId, runId: qualificationRunId, sourceCommit: qualificationCommit },
    phone: { path: phonePath, ownerResponse, workerVersionId, requestedChecks },
    alertDelivery: { path: alertPath, runId: alertRunId, sourceCommit: alertCommit },
  },
  evidence_4: {
    schemaVersion: 1,
    acceptanceType: "owner-phone-report",
    reportedDate: "2000-01-01",
    confirmationQuestion: "Synthetic prompt asking whether the fixture upload and rendering flow works.",
    ownerResponse,
    storefront: "https://storefront.example.invalid",
    developmentReleaseId: releaseId,
    workerVersionId,
    imageDigest,
    qualificationRunId,
    requestedChecks,
    measuredLatency: null,
    deviceDetails: "Synthetic test device; no owner device data.",
    evidenceScope: "Synthetic evidence for unit tests only. This does not certify a deployment.",
    storefrontDeployment: "https://synthetic-deployment.example.invalid",
    storefrontSourceCommit: digest("storefront source commit", "sha1"),
    storefrontRunId: 80000000902,
  },
  evidence_5: {
    schemaVersion: 1,
    acceptanceType: "owner-email-receipt-report",
    reportedDate: "2000-01-01",
    environment: "production",
    verificationRunId: alertRunId,
    verificationSourceCommit: alertCommit,
    subject: "Synthetic alert receipt fixture",
    ownerConfirmedReceipt: true,
    emailSubscriptionConfirmed: true,
    runtimeAlarmsVerified: 7,
    firstAndAllReadyMonitoringComplete: false,
    productionRenderingEnabledByThisCheck: false,
  },
};
