import tseslint from "@typescript-eslint/eslint-plugin";
import drizzle from "eslint-plugin-drizzle";
import nextVitals from "eslint-config-next/core-web-vitals";

export default [
  {
    ignores: ["eslint.config.mjs", "postcss.config.js", "prettier.config.js"],
  },
  ...nextVitals,
  ...tseslint.configs["flat/recommended-type-checked"],
  ...tseslint.configs["flat/stylistic-type-checked"],
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    plugins: {
      drizzle,
    },
    rules: {
      "@typescript-eslint/array-type": "off",
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/ban-tslint-comment": "off",
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        {
          prefer: "type-imports",
          fixStyle: "inline-type-imports",
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-misused-promises": [
        "error",
        {
          checksVoidReturn: {
            attributes: false,
          },
        },
      ],
      "drizzle/enforce-delete-with-where": [
        "error",
        {
          drizzleObjectName: ["db", "ctx.db"],
        },
      ],
      "drizzle/enforce-update-with-where": [
        "error",
        {
          drizzleObjectName: ["db", "ctx.db"],
        },
      ],
    },
  },
];
