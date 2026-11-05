import eslint from "@eslint/js";
import importPlugin from "eslint-plugin-import";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

const sourceFiles = ["**/*.{js,mjs,cjs,ts,tsx}"];
const typescriptFiles = ["**/*.{ts,tsx}"];

export function baseConfig({ tsconfigRootDir }) {
  return defineConfig(
    globalIgnores([
      ".next/**",
      ".turbo/**",
      ".cache/**",
      "build/**",
      "coverage/**",
      "dist/**",
      "node_modules/**",
      "out/**",
      "next-env.d.ts",
      "**/*.config.*",
    ]),
    {
      files: sourceFiles,
      extends: [eslint.configs.recommended],
      linterOptions: {
        reportUnusedDisableDirectives: "error",
      },
    },
    {
      files: typescriptFiles,
      extends: [
        ...tseslint.configs.recommended,
        ...tseslint.configs.recommendedTypeChecked,
        ...tseslint.configs.stylisticTypeChecked,
      ],
      languageOptions: {
        parserOptions: {
          projectService: true,
          tsconfigRootDir,
        },
      },
      rules: {
        "@typescript-eslint/consistent-type-imports": [
          "error",
          {
            fixStyle: "separate-type-imports",
            prefer: "type-imports",
          },
        ],
        "@typescript-eslint/consistent-type-definitions": "off",
        "@typescript-eslint/no-explicit-any": "error",
        "@typescript-eslint/no-non-null-assertion": "error",
        "@typescript-eslint/no-unnecessary-condition": [
          "error",
          {
            allowConstantLoopConditions: "only-allowed-literals",
          },
        ],
        "@typescript-eslint/no-unnecessary-type-assertion": "error",
        "@typescript-eslint/no-unused-vars": [
          "error",
          {
            argsIgnorePattern: "^_",
            varsIgnorePattern: "^_",
          },
        ],
        "@typescript-eslint/require-await": "off",
        "@typescript-eslint/switch-exhaustiveness-check": "error",
      },
    },
    {
      files: sourceFiles,
      plugins: {
        import: importPlugin,
      },
      rules: {
        "import/consistent-type-specifier-style": ["error", "prefer-top-level"],
        "import/first": "error",
        "import/newline-after-import": "error",
        "import/no-duplicates": "error",
        "import/no-mutable-exports": "error",
        "import/no-self-import": "error",
        "import/no-useless-path-segments": "error",
        "import/order": [
          "error",
          {
            alphabetize: {
              caseInsensitive: true,
              order: "asc",
            },
            groups: [
              "builtin",
              "external",
              "internal",
              "parent",
              "sibling",
              "index",
              "object",
              "type",
            ],
            "newlines-between": "always",
            pathGroups: [
              {
                group: "internal",
                pattern: "@/**",
                position: "before",
              },
              {
                group: "internal",
                pattern: "@bent-build/**",
                position: "before",
              },
            ],
            pathGroupsExcludedImportTypes: ["builtin"],
          },
        ],
      },
    }
  );
}
