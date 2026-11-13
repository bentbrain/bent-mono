import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { verifyProductImageV5Capsule } from "./product-image-v5-capsule.mjs";

if (process.argv.length !== 3) throw new Error("Usage: node product-image-v5-smoke.mjs <capsule-directory>");
const directory = process.argv[2], manifest = await verifyProductImageV5Capsule(directory);
const binding = JSON.parse(process.env.SHOP_PRODUCT_IMAGE_V5_BINDING_JSON ?? "null");
if (binding?.environment !== "local-proof") throw new Error("The native v5 smoke requires a synthetic local-proof binding.");
let input = Buffer.alloc(0);
for await (const chunk of process.stdin) {
    input = Buffer.concat([input, chunk]);
    if (input.length > 2048) throw new Error("Smoke event exceeds limit.");
}
const { handler } = await import(pathToFileURL(join(directory, manifest.entry)));
const result = await handler(JSON.parse(input.toString("utf8")), {
    invokedFunctionArn: binding.qualifiedFunctionArns[0], awsRequestId: "synthetic-capsule-smoke",
    getRemainingTimeInMillis: () => 120000,
});
console.log(JSON.stringify({ kind: "native-v5-local-smoke", runtime: manifest.runtime, filesSha256: manifest.filesSha256, awsImageQualified: false, result }));
