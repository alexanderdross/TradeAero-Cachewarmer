// ESLint v9 flat config. Keeps the rule set intentionally small so Next.js
// conventions (App Router components, server/client split) are not fought; we
// only enforce TS hygiene. Test files get vitest globals added on top so
// describe/it/expect do not trip no-undef even if a suite forgets to import
// them explicitly.
//
// Design notes for the rule overrides below:
//   * no-explicit-any is OFF, not "warn", because the runAllChannels dispatcher
//     in src/lib/channels/index.ts stores heterogeneous channel configs in a
//     Record<string, any> — the per-channel warm* functions each narrow from
//     there, and typing the dispatcher generically would require a discriminated
//     union of all 10 channels, which is churn for no runtime payoff.
//   * no-empty-object-type is OFF because the sibling-repo CI surfaces have
//     already flagged false positives here (React prop interfaces, etc.).
//   * no-unused-vars gets caughtErrorsIgnorePattern so `catch (err)` where the
//     body only does `failed++` does not force us to rename every handler.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "next-env.d.ts",
      "coverage/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        // Next.js runs on Node (API routes, server components) and in the
        // browser (client components) — include both surfaces.
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        Request: "readonly",
        Response: "readonly",
        Headers: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
    },
  },
  {
    files: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/**/__tests__/**/*.ts"],
    languageOptions: {
      globals: {
        describe: "readonly",
        it: "readonly",
        test: "readonly",
        expect: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        beforeAll: "readonly",
        afterAll: "readonly",
        vi: "readonly",
      },
    },
  },
];
