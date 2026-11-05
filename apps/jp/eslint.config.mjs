import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import astro from 'eslint-plugin-astro';
import globals from 'globals';
export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'artifacts/**',
      '.astro/**',
      '.wrangler/**',
      '.agents/**',
      '.emdash/**',
      'worker-configuration.d.ts',
      'emdash-env.d.ts',
      'mockups/assets/**',
      'public/**',
    ],
  },
  {
    files: ['**/*.mjs', 'mockups/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
        d3: 'readonly',
        topojson: 'readonly',
      },
    },
    rules: {
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    files: ['src/**/*.ts', 'src/**/*.tsx', 'scripts/**/*.ts', 'tests/**/*.ts'],
    extends: [...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'never' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  ...astro.configs.recommended,
  { files: ['**/*.astro'], rules: { 'astro/no-set-html-directive': 'error' } },
);
