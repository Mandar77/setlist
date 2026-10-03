// ESLint flat config for the whole workspace.
//
// Two jobs beyond ordinary linting:
//
//   1. Keep `packages/core` PURE. ADR-001 makes it the single song grammar, running on
//      Hermes in the Expo app, in the browser, and in Node Lambdas. A stray `node:fs`
//      or `window` import would compile fine and then fail on one engine at runtime —
//      which is precisely the drift the single-core decision exists to prevent. The
//      rule below makes that a lint error instead of a device-only bug.
//
//   2. Keep the $0 guardrails honest. Importing an AWS SDK client for a banned service
//      is a cost decision disguised as an import, so the banned ones are named here as
//      well as in the cdk-nag pack.

import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

/** Services on the never-use list (PED §12). Importing a client is a cost decision. */
const BANNED_AWS_CLIENTS = [
  '@aws-sdk/client-bedrock',
  '@aws-sdk/client-bedrock-runtime',
  '@aws-sdk/client-textract',
  '@aws-sdk/client-rekognition',
  '@aws-sdk/client-athena',
  '@aws-sdk/client-secrets-manager',
  '@aws-sdk/client-cost-explorer',
  '@aws-sdk/client-wafv2',
  '@aws-sdk/client-route-53',
]

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cdk.out/**',
      '**/coverage/**',
      '**/.venv/**',
      '**/*.d.ts',
      // Deliberately ill-typed; they exist to prove the typecheck gate is not vacuous.
      'tools/toolchain-smoke/fixtures/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
      'no-restricted-imports': [
        'error',
        {
          paths: BANNED_AWS_CLIENTS.map(name => ({
            name,
            message:
              'On the never-use list (PED §12). Adding this is a cost decision, not an import.',
          })),
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },

  {
    // ADR-001: the core runs on Node, in a browser and on Hermes. It may depend on
    // none of them.
    files: ['packages/core/**/*.ts'],
    languageOptions: {
      // No Node, no DOM. Anything reached for here is a portability bug.
      globals: {},
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'os', 'crypto', 'child_process', 'http', 'https'],
              message:
                'packages/core must stay pure (ADR-001): it runs on Hermes and in the browser. ' +
                'Put platform access behind an interface the caller supplies.',
            },
            {
              group: ['react', 'react-native', 'expo*', '@aws-sdk/*'],
              message:
                'packages/core must stay framework- and cloud-free (ADR-001). ' +
                'It is imported by the device, the PWA and Node Lambdas alike.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'packages/core must not assume a browser (ADR-001).' },
        { name: 'document', message: 'packages/core must not assume a DOM (ADR-001).' },
        { name: 'process', message: 'packages/core must not assume Node (ADR-001).' },
        { name: '__dirname', message: 'packages/core must not assume Node (ADR-001).' },
      ],
    },
  },

  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  {
    // The core's own tests may touch Node; the core may not.
    //
    // The purity rule above exists so that `packages/core` runs unchanged on Hermes and
    // in a browser (ADR-001). Its tests are a different thing: the differential suite
    // has to read a 3 MB fixture off disk to compare 4,897 oracle answers, and there is
    // no portable way to do that, nor any reason to want one. What must stay pure is
    // what ships, and `src/` is what ships.
    //
    // CORE-06's conformance suite is deliberately NOT covered by this exemption — it is
    // a reusable export that runs on Chromium and Hermes as well as Node, so it lives
    // in `src/` and is bound by the rule like the rest of the core.
    files: ['packages/core/test/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },

  {
    // CLI entrypoints: stdout is the interface, not a debugging leftover. Mirrors the
    // `tools/**` exemption for T201 on the Python side.
    // `infra/bootstrap/generate.ts` and the estimator CLI are the same thing wearing a
    // different path: command-line entrypoints whose output IS the product.
    files: [
      'tools/**/*.{js,mjs,ts}',
      'infra/bootstrap/generate.ts',
      'infra/**/cli.ts',
      '**/src/cli.ts',
    ],
    rules: {
      'no-console': 'off',
    },
  },

  // Must stay last: turns off every rule that would fight Prettier.
  prettier,
)
