import { readFile } from "node:fs/promises";
import { sha256 } from "./contract.mjs";
import { VARIANTS } from "./variants.mjs";

const bytes = await readFile("bundle-manifest.json");
if (!/^[0-9a-f]{64}$/.test(process.env.SOURCE_DIGEST ?? "") || sha256(bytes) !== process.env.SOURCE_DIGEST) {
  throw new Error("Cloud build source manifest does not match the requested digest.");
}
const manifest = JSON.parse(bytes);
for (const [path, hash] of Object.entries(manifest.files)) {
  const allowedPath = ["aws-lambda/Dockerfile", "aws-lambda/Dockerfile.app"].includes(path) ||
    /^(src|aws-lambda)\/[a-z0-9.-]+$/.test(path) || ["product-assets/lifestyle-white.png","product-assets/lifestyle-black.png","product-assets/lifestyle.json","product-assets/featured-mask-white.svg","product-assets/featured-mask-black.svg"].includes(path) || Object.values(VARIANTS).some(v => path === `product-assets/${v.file}`);
  if (!allowedPath || sha256(await readFile(path)) !== hash) {
    throw new Error("Cloud build source file mismatch.");
  }
}
console.info("Verified the isolated source bundle.");
