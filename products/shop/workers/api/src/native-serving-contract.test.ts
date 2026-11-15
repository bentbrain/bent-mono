import { describe, expect, it } from "vitest";
import { canonicalNativeServingTarget, parseNativeServingTarget } from "@forever-tee/contracts/native-serving-target";

const main = "arn:aws:lambda:ap-southeast-2:123456789012:function:serving-main";
const failure = "arn:aws:lambda:ap-southeast-2:123456789012:function:serving-failure";
const pins = { environment: "development", mainFunctionArn: main, failureFunctionArn: failure };
function parsed(value: unknown, environment: "development" | "production" = "development") {
    return parseNativeServingTarget(JSON.stringify(value), { ...pins, environment });
}
const valid = { schema: "shop.native-serving-target/v1", environment: "development", functionArn: `${main}:7`, failureFunctionArn: `${failure}:8`,
    imageDigest: "a".repeat(64), codeDigest: "b".repeat(64), inputsDigest: "c".repeat(64), buildId: "d".repeat(64), qualificationDigest: "e".repeat(64), grantKeyId: "serving-grant-v1" };

describe("shared native serving contract", () => {
    it("binds one exact immutable pair and emits stable bytes in Worker and provider consumers", () => {
        const target = parsed(valid);
        expect(target).toEqual(valid);
        expect(Object.isFrozen(target)).toBe(true);
        expect(canonicalNativeServingTarget(target)).toBe(canonicalNativeServingTarget(parsed(JSON.parse(canonicalNativeServingTarget(target)))));
        expect(parsed({ ...valid, environment: "production" }, "production").environment).toBe("production");
    });
    it.each([
        { functionArn: `${main}:$LATEST` }, { functionArn: `${main}:live` }, { functionArn: `${main}:0` }, { functionArn: `${main}:01` },
        { functionArn: `${main}:9007199254740992` }, { functionArn: `${main}:7:extra` }, { failureFunctionArn: `${main}:8` },
        { failureFunctionArn: valid.failureFunctionArn.replace("123456789012", "999999999999") },
        { functionArn: valid.functionArn.replace("ap-southeast-2", "us-east-1") }, { environment: "production" }, { environment: "qualification" },
        { schema: "shop.native-serving-target/v2" }, { qualificationDigest: "f".repeat(63) }, { imageDigest: "A".repeat(64) },
        { grantKeyId: "keys/main" }, { grantKeyId: "" }, { buildId: 7 }, { unknown: true }, { functionArn: { value: valid.functionArn } },
    ])("rejects target substitution before credentials: %j", changed => {
        expect(() => parsed({ ...valid, ...changed })).toThrow();
    });
    it("rejects ambiguous JSON, missing fields and independent pin substitution", () => {
        const serialized = JSON.stringify(valid);
        for (const invalid of [serialized.slice(0, -1) + ',"environment":"development"}',
            serialized.slice(0, -1) + ',"environm\\u0065nt":"development"}', serialized.repeat(20), "[]", "null", "{}", "false", "not-json"]) {
            expect(() => parseNativeServingTarget(invalid, { ...pins, environment: "development" })).toThrow();
        }
        const { buildId, ...incomplete } = valid;
        expect(buildId).toHaveLength(64);
        expect(() => parsed(incomplete)).toThrow();
        for (const changed of [{ mainFunctionArn: `${main}:7` }, { failureFunctionArn: main },
            { failureFunctionArn: failure.replace("123456789012", "999999999999") }, { mainFunctionArn: `${main}-other` }]) {
            expect(() => parseNativeServingTarget(serialized, { ...pins, ...changed, environment: "development" })).toThrow();
        }
    });
});
