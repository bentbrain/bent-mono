import { FlatCompat } from "@eslint/eslintrc";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals.js";
import nextTypescript from "eslint-config-next/typescript.js";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
  resolvePluginsRelativeTo: dirname(require.resolve("eslint-config-next/package.json")),
});

const config = [
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts"],
  },
  ...compat.config(nextCoreWebVitals),
  ...compat.config(nextTypescript),
];

export default config;
