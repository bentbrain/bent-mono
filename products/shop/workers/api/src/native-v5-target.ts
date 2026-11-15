import { parseNativeServingTarget, type NativeServingTarget } from "@forever-tee/contracts/native-serving-target";
import { installedNativeServingTarget, nativeServingPins, type NativeServingEnv } from "./native-serving-target";
import { protectedConfig } from "./protected-config";
import { createStoryVideoGrant } from "./story-video-grants";

interface NativeV5TargetBase {
    readonly environment: "qualification";
    readonly functionArn: string;
    readonly codeDigest: string;
    readonly inputsDigest: string;
    readonly grantKeyId: string;
}
export type NativeV5Target = (NativeV5TargetBase & (
    { readonly schemaVersion: 1; readonly qualificationDigest: string } |
    { readonly schemaVersion: 2; readonly bootstrapAuthorityDigest: string }
)) | (Omit<NativeServingTarget, "schema"> & { readonly schemaVersion: 3 });
export interface NativeV5TargetEnv extends NativeServingEnv {
    readonly SHOP_NATIVE_V5_TARGET_JSON?: string;
    readonly SHOP_NATIVE_V5_GRANT_SECRET?: string;
    readonly SHOP_NATIVE_V5_RETAINED_GRANT_SECRETS_JSON?: string;
    readonly STORY_VIDEO_ENVIRONMENT?: string;
    readonly OPERATIONS_ENVIRONMENT?: string;
}
export interface NativeV5Acceptance {
    readonly job_id: string;
    readonly attempt: number;
    readonly target_json: string;
    readonly target_digest: string;
    readonly input_json: string;
    readonly input_digest: string;
    readonly grant_sha256: string;
    readonly grant_expires_at: number;
    readonly request_sha256: string;
    readonly dispatch_state: "prepared" | "accepted" | "uncertain" | "rejected";
}
const HASH = /^[a-f0-9]{64}$/;
const FIELDS = ["schemaVersion", "environment", "functionArn", "codeDigest", "inputsDigest", "grantKeyId"];
export function canonicalNativeIdentity(value: unknown): string {
    if (value === null || typeof value !== "object") {
        const encoded = JSON.stringify(value);
        if (typeof encoded !== "string" || (typeof value === "number" && !Number.isFinite(value))) throw new Error("Expected a finite JSON native identity.");
        return encoded;
    }
    if (Array.isArray(value)) return `[${value.map(canonicalNativeIdentity).join(",")}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalNativeIdentity(Reflect.get(value, key))}`).join(",")}}`;
}
export async function hasNativeV5Schema(db: D1Database) {
    return await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='native_v5_dispatches'").first() !== null;
}
export async function nativeIdentityDigest(value: string | Uint8Array) {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}
export function parseNativeV5Target(serialized: string): NativeV5Target {
    if (serialized.length > 8192) throw new Error("Native v5 target exceeds its configuration bound.");
    const value: unknown = JSON.parse(serialized);
    if (typeof value === "object" && value !== null && "schemaVersion" in value && value.schemaVersion === 3) {
        const rest = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "schemaVersion"));
        if (serialized !== canonicalNativeIdentity(value)) throw new Error("Retained serving targets require canonical unique JSON fields.");
        const target = parseNativeServingTarget(JSON.stringify({ schema: "shop.native-serving-target/v1", ...rest }), nativeServingPins({
            STORY_VIDEO_ENVIRONMENT: "environment" in value && value.environment === "production" ? "production" : "development",
        }));
        return normalNativeV5Target(target);
    }
    const bootstrap = typeof value === 'object' && value !== null && 'schemaVersion' in value && value.schemaVersion === 2;
    const fields = [...FIELDS, bootstrap ? 'bootstrapAuthorityDigest' : 'qualificationDigest'];
    const propertyTokens = serialized.match(/"(?:[^"\\]|\\.)*"\s*:/g) ?? [];
    const properties = propertyTokens.map(token => {
        const property: unknown = JSON.parse(token.slice(0, token.lastIndexOf('"') + 1));
        if (typeof property !== "string") throw new Error("Expected a native target field name.");
        return property;
    });
    if (properties.length !== fields.length || new Set(properties).size !== properties.length) throw new Error("Native v5 target fields must be unique and complete.");
    if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== fields.length || !fields.every(key => Object.hasOwn(value, key)) ||
        !("schemaVersion" in value) || value.schemaVersion !== 1 && value.schemaVersion !== 2 || !("environment" in value) || value.environment !== "qualification" ||
        !("functionArn" in value) || typeof value.functionArn !== "string" || !/^arn:aws:lambda:ap-southeast-2:[0-9]{12}:function:[A-Za-z0-9_-]{1,64}:[1-9][0-9]*$/.test(value.functionArn) ||
        !("codeDigest" in value) || typeof value.codeDigest !== "string" || !HASH.test(value.codeDigest) ||
        !("inputsDigest" in value) || typeof value.inputsDigest !== "string" || !HASH.test(value.inputsDigest) ||
        !("grantKeyId" in value) || typeof value.grantKeyId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.grantKeyId)) {
        throw new Error("Expected an admitted qualification-only numbered native v5 target.");
    }
    const common: NativeV5TargetBase = { environment: "qualification", functionArn: value.functionArn, codeDigest: value.codeDigest,
        inputsDigest: value.inputsDigest, grantKeyId: value.grantKeyId };
    if (value.schemaVersion === 1 && 'qualificationDigest' in value && typeof value.qualificationDigest === 'string' && HASH.test(value.qualificationDigest))
        return { ...common, schemaVersion: 1, qualificationDigest: value.qualificationDigest };
    if (value.schemaVersion === 2 && 'bootstrapAuthorityDigest' in value && typeof value.bootstrapAuthorityDigest === 'string' && HASH.test(value.bootstrapAuthorityDigest))
        return { ...common, schemaVersion: 2, bootstrapAuthorityDigest: value.bootstrapAuthorityDigest };
    throw new Error('Expected an exact native qualification or bootstrap authority digest.');
}
function normalNativeV5Target(target: NativeServingTarget): NativeV5Target {
    return { schemaVersion: 3, environment: target.environment, functionArn: target.functionArn, failureFunctionArn: target.failureFunctionArn,
        imageDigest: target.imageDigest, codeDigest: target.codeDigest, inputsDigest: target.inputsDigest, buildId: target.buildId,
        qualificationDigest: target.qualificationDigest, grantKeyId: target.grantKeyId };
}
export async function admittedNativeV5Target(env: NativeV5TargetEnv): Promise<NativeV5Target | undefined> {
    const serving = installedNativeServingTarget(env);
    if (serving) {
        if (env.SHOP_NATIVE_V5_TARGET_JSON !== undefined) throw new Error("Install exactly one native dispatch target.");
        return normalNativeV5Target(serving);
    }
    if (env.SHOP_NATIVE_V5_TARGET_JSON === undefined) return undefined;
    if (env.STORY_VIDEO_ENVIRONMENT === "production" || env.OPERATIONS_ENVIRONMENT === "production") throw new Error("Native v5 target admission is restricted to qualification.");
    const target = parseNativeV5Target(env.SHOP_NATIVE_V5_TARGET_JSON);
    if (target.schemaVersion !== 1) throw new Error('A bootstrap target cannot select the normal native dispatcher.');
    const resource = protectedConfig("nativeV5QualificationFunctionArn");
    if (!resource.startsWith(`arn:aws:lambda:ap-southeast-2:${protectedConfig("awsAccountId")}:function:`) ||
        !target.functionArn.startsWith(`${resource}:`) || !/^[1-9][0-9]*$/.test(target.functionArn.slice(resource.length + 1)) ||
        await nativeIdentityDigest(canonicalNativeIdentity(target)) !== protectedConfig("nativeV5QualificationTargetDigest")) {
        throw new Error("Native v5 target differs from the independently installed qualification admission.");
    }
    return target;
}
export async function retainedNativeV5Dispatch(db: D1Database, jobId: string) {
    const row = await db.prepare("SELECT * FROM native_v5_dispatches WHERE job_id=? ORDER BY attempt DESC LIMIT 1").bind(jobId).first<NativeV5Acceptance>();
    if (!row) return undefined;
    const target = parseNativeV5Target(row.target_json);
    if (await nativeIdentityDigest(canonicalNativeIdentity(target)) !== row.target_digest || await nativeIdentityDigest(row.input_json) !== row.input_digest) throw new Error("Retained native v5 target or input identity changed.");
    return { target, acceptance: row };
}
export async function prepareNativeV5Acceptance(env: NativeV5TargetEnv, target: NativeV5Target, current: NativeV5Target | undefined,
    jobId: string, attempt: number, input: unknown, now: number) {
    let secret = current?.grantKeyId === target.grantKeyId ? env.SHOP_NATIVE_V5_GRANT_SECRET : undefined;
    if (!secret && env.SHOP_NATIVE_V5_RETAINED_GRANT_SECRETS_JSON) {
        if (env.SHOP_NATIVE_V5_RETAINED_GRANT_SECRETS_JSON.length > 65536) throw new Error("Retained native grant keys exceed their configuration bound.");
        const keys: unknown = JSON.parse(env.SHOP_NATIVE_V5_RETAINED_GRANT_SECRETS_JSON);
        if (typeof keys === "object" && keys !== null && !Array.isArray(keys) && Object.hasOwn(keys, target.grantKeyId)) {
            const value: unknown = Reflect.get(keys, target.grantKeyId);
            if (typeof value === "string") secret = value;
        }
    }
    if (!secret || secret.length < 32 || secret.length > 4096) throw new Error("Install the retained native v5 grant key before accepting another attempt.");
    const grant = `nv5_${await createStoryVideoGrant(secret, jobId, attempt, now)}`;
    const body = JSON.stringify({ kind: "product-image-v5", schemaVersion: 1, jobId, grant, rendererVersion: "product-images-v5" });
    const targetJSON = canonicalNativeIdentity(target), inputJSON = canonicalNativeIdentity(input);
    if (inputJSON.length > 16384) throw new Error("Native v5 accepted input exceeds its bound.");
    return { target, body, grant, jobId, attempt, acceptedAt: now, targetJSON, targetDigest: await nativeIdentityDigest(targetJSON),
        inputJSON, inputDigest: await nativeIdentityDigest(inputJSON), grantDigest: await nativeIdentityDigest(grant), expiresAt: now + 180000,
        requestDigest: await nativeIdentityDigest(body) };
}
export function nativeV5AcceptanceStatement(db: D1Database, acceptance: Awaited<ReturnType<typeof prepareNativeV5Acceptance>>) {
    return db.prepare(`INSERT INTO native_v5_dispatches(job_id,attempt,target_json,target_digest,input_json,input_digest,grant_sha256,grant_expires_at,request_sha256,accepted_at,dispatch_state)
      SELECT ?,?,?,?,?,?,?,?,?,?,'prepared' FROM product_image_jobs WHERE id=? AND attempt_count=? AND status='rendering'
      ON CONFLICT(job_id,attempt) DO NOTHING`).bind(acceptance.jobId, acceptance.attempt, acceptance.targetJSON, acceptance.targetDigest,
        acceptance.inputJSON, acceptance.inputDigest, acceptance.grantDigest, acceptance.expiresAt, acceptance.requestDigest, acceptance.acceptedAt,
        acceptance.jobId, acceptance.attempt);
}
export async function acceptedNativeV5Grant(db: D1Database, token: string, jobId: string, now: number, failureGraceMs = 0) {
    if (!token.startsWith("nv5_") || token.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return undefined;
    if (!await hasNativeV5Schema(db)) return undefined;
    const row = await db.prepare("SELECT * FROM native_v5_dispatches WHERE job_id=? AND grant_sha256=?").bind(jobId, await nativeIdentityDigest(token)).first<NativeV5Acceptance>();
    if (!row || row.grant_expires_at <= now - failureGraceMs || row.grant_expires_at > now + 180000 ||
        !Number.isInteger(row.attempt) || row.attempt < 1 || row.attempt > 3 || row.dispatch_state === "rejected" ||
        await nativeIdentityDigest(row.input_json) !== row.input_digest || await nativeIdentityDigest(row.target_json) !== row.target_digest ||
        await nativeIdentityDigest(JSON.stringify({ kind: "product-image-v5", schemaVersion: 1, jobId, grant: token, rendererVersion: "product-images-v5" })) !== row.request_sha256) return undefined;
    try { if (canonicalNativeIdentity(parseNativeV5Target(row.target_json)) !== row.target_json) return undefined; }
    catch { return undefined; }
    return { attempt: row.attempt, expiresAt: row.grant_expires_at, acceptance: row };
}
