// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs', 'scripts/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      // Disabled: pre-existing unsafe-* violations throughout codebase
      // T10 (2026-08-22): swept 341 -> 238, but left OFF deliberately.
      //
      // Turning it to 'warn' is not viable yet: the pre-push hook lints changed
      // files with --max-warnings=0, so any commit touching a file that still
      // holds an `any` is blocked — while lint:ci has no warning threshold at
      // all, so CI would ignore it. At 'warn' the rule is therefore either
      // blocking local work or doing nothing.
      //
      // The remaining 238 are overwhelmingly Mongoose `{ _id, uid } as any`
      // filter literals, which need the schemas' `_id: string & ObjectId`
      // declaration fixed first (FilterQuery does not help — Mongoose 9 renamed
      // it to QueryFilter, which is the same strict type). Enable this once
      // that lands, together with a --max-warnings budget in lint:ci.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-enum-comparison': 'off',
      // Disabled: pre-existing violations in spec files and source
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      // RE-ENABLED (T0): an un-awaited promise in a money or order path fails
      // silently — the rejection is swallowed and the caller proceeds as if it
      // succeeded. The codebase was already clean; this keeps it that way.
      '@typescript-eslint/no-floating-promises': 'error',
      // RE-ENABLED (T0): blocks containing an explanatory comment are still
      // allowed, so deliberate best-effort catches pass — silent ones do not.
      'no-empty': 'error',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
);
