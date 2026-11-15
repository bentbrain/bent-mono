export interface NativeServingTarget {
  readonly schema: "shop.native-serving-target/v1";
  readonly environment: "development" | "production";
  readonly functionArn: string;
  readonly failureFunctionArn: string;
  readonly imageDigest: string;
  readonly codeDigest: string;
  readonly inputsDigest: string;
  readonly buildId: string;
  readonly qualificationDigest: string;
  readonly grantKeyId: string;
}
export interface NativeServingPins {
  readonly environment: "development" | "production";
  readonly mainFunctionArn: string;
  readonly failureFunctionArn: string;
}
export function canonicalNativeServingTarget(target: NativeServingTarget): string;
export function parseNativeServingTarget(serialized: string, pins: NativeServingPins): NativeServingTarget;
