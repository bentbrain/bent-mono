import js from "@eslint/js";
import ts from "typescript-eslint";

export default ts.config(js.configs.recommended, ...ts.configs.recommended, {
  files: ["**/*.ts", "**/*.tsx"],
  rules: {
    "@typescript-eslint/consistent-type-imports": "error",
    "@typescript-eslint/no-explicit-any": "error",
  },
});
