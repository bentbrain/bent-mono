import { isAbsolute } from "node:path";
import { executeProductImage, parseProductImageEvent } from "@forever-tee/product-image-renderer/execution";

const ORIGINS = Object.freeze({
    development: "https://forever-tee-api-development.socialqueue.workers.dev",
    production: "https://forever-tee-api.socialqueue.workers.dev",
});
const BINDING_KEYS = ["schemaVersion", "environment", "apiOrigin", "functionArn", "qualifiedFunctionArns", "buildId"];
const EVENT_KEYS = ["kind", "schemaVersion", "jobId", "grant", "rendererVersion"];
function exactKeys(value, keys) {
    return value !== null && typeof value === "object" && !Array.isArray(value) &&
        Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
// This binding is installed by the trusted runtime, independently of job input.
// Local proofs use synthetic identities and a loopback API with no cloud client.
export function validateProductImageV5Binding(value) {
    if (!exactKeys(value, BINDING_KEYS) || value.schemaVersion !== 1 ||
        typeof value.apiOrigin !== "string" || typeof value.functionArn !== "string" ||
        !/^arn:aws:lambda:ap-southeast-2:[0-9]{12}:function:[A-Za-z0-9_-]{1,64}$/.test(value.functionArn) ||
        typeof value.buildId !== "string" || !/^[a-f0-9]{64}$/.test(value.buildId) ||
        !Array.isArray(value.qualifiedFunctionArns) || value.qualifiedFunctionArns.length < 1 ||
        value.qualifiedFunctionArns.length > 32 || new Set(value.qualifiedFunctionArns).size !== value.qualifiedFunctionArns.length ||
        !value.qualifiedFunctionArns.every(arn => typeof arn === "string" &&
            arn.startsWith(`${value.functionArn}:`) && /^[1-9][0-9]*$/.test(arn.slice(value.functionArn.length + 1))))
        throw new Error("Invalid native v5 binding.");
    if (value.environment === "local-proof") {
        let url;
        try { url = new URL(value.apiOrigin); }
        catch { throw new Error("Invalid native v5 API origin."); }
        if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.origin !== value.apiOrigin)
            throw new Error("Expected a loopback native v5 API origin.");
    }
    else if (!Object.hasOwn(ORIGINS, value.environment) || value.apiOrigin !== ORIGINS[value.environment])
        throw new Error("Invalid native v5 API origin.");
    return Object.freeze({ ...value, qualifiedFunctionArns: Object.freeze([...value.qualifiedFunctionArns]) });
}
export function validateProductImageV5Event(event) {
    const job = parseProductImageEvent(event);
    if (!exactKeys(event, EVENT_KEYS) || event.kind !== "product-image-v5" || event.schemaVersion !== 1 || !job ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(job.jobId) ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(job.grant) || Buffer.byteLength(JSON.stringify(event)) > 2048)
        throw new Error("Invalid native v5 event.");
    return job;
}
export function assertProductImageV5Invocation(context, binding) {
    if (!context || !binding.qualifiedFunctionArns.includes(context.invokedFunctionArn) ||
        typeof context.awsRequestId !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(context.awsRequestId) ||
        typeof context.getRemainingTimeInMillis !== "function")
        throw new Error("Expected an allowlisted qualified native v5 invocation.");
    const remaining = context.getRemainingTimeInMillis();
    // Execution has its existing 25 s deadline plus a 2 s fenced failure callback.
    if (!Number.isFinite(remaining) || remaining < 30000)
        throw new Error("Insufficient native v5 invocation time.");
}
export function createProductImageV5Handler({ binding: input, assetDirectory }) {
    const binding = validateProductImageV5Binding(input);
    if (typeof assetDirectory !== "string" || !isAbsolute(assetDirectory))
        throw new Error("Expected an absolute native v5 asset directory.");
    return async (event, context) => {
        assertProductImageV5Invocation(context, binding);
        const job = validateProductImageV5Event(event);
        const result = await executeProductImage(job, { apiUrl: binding.apiOrigin, assetDirectory, runtimeLabel: "native v5" });
        // A failed async Lambda delivery must remain eligible for durable recovery.
        if (result.status !== 200)
            throw new Error("Native v5 image execution unavailable.");
        return result.body;
    };
}
