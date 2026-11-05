import clerkNext from "@clerk/eslint-plugin/next";
import nextPlugin from "@next/eslint-plugin-next";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import { defineConfig } from "eslint/config";

import { baseConfig } from "./base.mjs";

const typescriptFiles = ["**/*.{ts,tsx}"];

export function nextjsConfig({ clerkRoutes, rootDir, tsconfigRootDir }) {
  return defineConfig(
    ...baseConfig({ tsconfigRootDir }),
    {
      files: typescriptFiles,
      extends: [
        reactPlugin.configs.flat.recommended,
        reactPlugin.configs.flat["jsx-runtime"],
        reactHooksPlugin.configs.flat["recommended-latest"],
        jsxA11y.flatConfigs.strict,
      ],
      settings: {
        react: {
          version: "detect",
        },
      },
      rules: {
        "react/jsx-no-useless-fragment": "error",
        "react/self-closing-comp": "error",
      },
    },
    {
      files: typescriptFiles,
      plugins: {
        "@clerk/next": clerkNext,
      },
      rules: {
        "@clerk/next/require-auth-protection": ["error", clerkRoutes],
      },
    },
    {
      files: typescriptFiles,
      plugins: {
        "@next/next": nextPlugin,
      },
      settings: {
        next: {
          rootDir,
        },
      },
      rules: {
        ...nextPlugin.configs.recommended.rules,
        ...nextPlugin.configs["core-web-vitals"].rules,
      },
    }
  );
}
