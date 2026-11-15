import { fileURLToPath } from "node:url";
import { assertProductImageV5Invocation, createProductImageV5Handler, validateProductImageV5Binding } from "./product-image-v5-handler.mjs";
import { verifyProductImageV5Runtime } from "./product-image-v5-integrity.mjs";
import { assertNativeNumberedInvocation, nativeRuntimeProfile } from './native-runtime-profile.mjs';

let execute;
export async function handler(event, context) {
    if (!execute) {
        const serialized = process.env.SHOP_PRODUCT_IMAGE_V5_BINDING_JSON;
        if (!serialized || Buffer.byteLength(serialized) > 16384)
            throw new Error("Install the native v5 runtime binding before invoking.");
        let binding;
        try {
            const input = JSON.parse(serialized);
            if (input?.schemaVersion === 2) {
                const fields = ['schemaVersion', 'environment', 'apiOrigin', 'functionArn', 'buildId', 'invocationMode'];
                const profile = nativeRuntimeProfile(process.env, input.environment);
                if (!profile || Object.keys(input).length !== fields.length || !fields.every(key => Object.hasOwn(input, key)) ||
                    input.invocationMode !== 'aws-numbered-version' || input.functionArn !== profile.canonicalMainFunctionArn ||
                    input.apiOrigin !== profile.canonicalApiOrigin || input.buildId !== profile.buildId) throw Error('Invalid numbered native v5 binding.');
                const arn = assertNativeNumberedInvocation(context, profile);
                binding = validateProductImageV5Binding({ schemaVersion: 1, environment: input.environment, apiOrigin: profile.apiOrigin,
                    functionArn: profile.mainFunctionArn, buildId: input.buildId, qualifiedFunctionArns: [arn] });
            } else binding = validateProductImageV5Binding(input);
        }
        catch { throw new Error("Invalid native v5 runtime binding."); }
        assertProductImageV5Invocation(context, binding);
        await verifyProductImageV5Runtime(fileURLToPath(new URL("./", import.meta.url)), binding.buildId);
        execute = createProductImageV5Handler({
            binding,
            assetDirectory: fileURLToPath(new URL("./assets/lifestyle-v4/", import.meta.url)),
        });
    }
    return execute(event, context);
}
