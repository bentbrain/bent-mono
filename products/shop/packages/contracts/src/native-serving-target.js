const FIELDS = ["schema", "environment", "functionArn", "failureFunctionArn", "imageDigest", "codeDigest", "inputsDigest", "buildId", "qualificationDigest", "grantKeyId"];
const HASH = /^[a-f0-9]{64}$/;
const BASE = /^arn:aws:lambda:ap-southeast-2:([0-9]{12}):function:([A-Za-z0-9_-]{1,64})$/;
const NUMBERED = /^arn:aws:lambda:ap-southeast-2:([0-9]{12}):function:([A-Za-z0-9_-]{1,64}):([1-9][0-9]{0,15})$/;

/** Deterministic bytes shared by protected deployment and retained job identities. */
export function canonicalNativeServingTarget(target) {
  return `{${Object.keys(target).sort().map(key => `${JSON.stringify(key)}:${JSON.stringify(target[key])}`).join(",")}}`;
}

/** Parse installed configuration against independent environment and resource pins. */
export function parseNativeServingTarget(serialized, { environment, mainFunctionArn, failureFunctionArn }) {
  if (typeof serialized !== "string" || serialized.length > 8192) throw new Error("Native serving target exceeds its configuration bound.");
  const main = BASE.exec(mainFunctionArn), failure = BASE.exec(failureFunctionArn);
  if (!main || !failure || main[1] !== failure[1] || mainFunctionArn === failureFunctionArn ||
      !["development", "production"].includes(environment)) throw new Error("Install distinct native serving resource and environment pins.");
  const value = JSON.parse(serialized);
  const tokens = serialized.match(/"(?:[^"\\]|\\.)*"\s*:/g) ?? [];
  const properties = tokens.map(token => JSON.parse(token.slice(0, token.lastIndexOf('"') + 1)));
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== FIELDS.length || !FIELDS.every(key => Object.hasOwn(value, key)) ||
      properties.length !== FIELDS.length || new Set(properties).size !== properties.length ||
      value.schema !== "shop.native-serving-target/v1" || value.environment !== environment ||
      typeof value.functionArn !== "string" || typeof value.failureFunctionArn !== "string" ||
      !NUMBERED.test(value.functionArn) || !NUMBERED.test(value.failureFunctionArn) ||
      !value.functionArn.startsWith(`${mainFunctionArn}:`) || !value.failureFunctionArn.startsWith(`${failureFunctionArn}:`) ||
      !["imageDigest", "codeDigest", "inputsDigest", "buildId", "qualificationDigest"].every(key => typeof value[key] === "string" && HASH.test(value[key])) ||
      typeof value.grantKeyId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.grantKeyId)) {
    throw new Error("Expected one complete independently pinned numbered native serving target.");
  }
  const mainVersion = value.functionArn.slice(mainFunctionArn.length + 1), failureVersion = value.failureFunctionArn.slice(failureFunctionArn.length + 1);
  if (!Number.isSafeInteger(Number(mainVersion)) || !Number.isSafeInteger(Number(failureVersion))) throw new Error("Native serving versions must be safe positive integers.");
  return Object.freeze({ schema: "shop.native-serving-target/v1", environment: value.environment,
    functionArn: value.functionArn, failureFunctionArn: value.failureFunctionArn,
    imageDigest: value.imageDigest, codeDigest: value.codeDigest, inputsDigest: value.inputsDigest,
    buildId: value.buildId, qualificationDigest: value.qualificationDigest, grantKeyId: value.grantKeyId });
}
