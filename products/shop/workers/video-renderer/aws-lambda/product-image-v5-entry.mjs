import { fileURLToPath } from "node:url";
import { assertProductImageV5Invocation, createProductImageV5Handler, validateProductImageV5Binding } from "./product-image-v5-handler.mjs";
import { verifyProductImageV5Runtime } from "./product-image-v5-integrity.mjs";

let execute;
export async function handler(event, context) {
    if (!execute) {
        const serialized = process.env.SHOP_PRODUCT_IMAGE_V5_BINDING_JSON;
        if (!serialized || Buffer.byteLength(serialized) > 16384)
            throw new Error("Install the native v5 runtime binding before invoking.");
        let binding;
        try { binding = validateProductImageV5Binding(JSON.parse(serialized)); }
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
