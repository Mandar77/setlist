import { defineConfig } from 'vitest/config'

/**
 * The core's own test configuration, which exists for the coverage gate.
 *
 * Running `vitest` from the repo root uses the root config and collects every workspace
 * suite; running it here collects only this package's, which is what a per-package
 * coverage threshold has to be measured over. ADR-001 and CLAUDE.md both put the core at
 * ≥90% — higher than the 85% the rest of the repo carries, because this is the one
 * package that ships to three runtimes and has no integration test behind it.
 *
 * `include` and `exclude` are stated rather than inherited for the reason the root config
 * gives at length: Vitest 5 collects build output that Vitest 2 ignored, so `tsc --build`
 * emissions under `dist/` would run as a second, stale copy of every suite.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The Chromium conformance runner is excluded from the default run: it downloads and
    // launches a browser, and `make verify` must stay fast and dependency-light. It runs
    // under `pnpm -C packages/core test:conformance`, which CI calls after
    // `playwright install chromium`.
    exclude: ['**/node_modules/**', '**/dist/**', 'test/conformance.browser.test.ts'],

    // The differential suites parse a 3 MB fixture and run the pipeline ten thousand
    // times. Comfortably under this, but not under the 5s default.
    testTimeout: 30_000,

    coverage: {
      provider: 'v8',

      // `src/` only. Measuring the tests themselves inflates the number with code that
      // is 100% covered by definition, which is the most common way a coverage gate
      // comes to mean nothing.
      include: ['src/**/*.ts'],
      // Re-exports and type declarations: no statements to execute, and counting them
      // moves the percentage without changing what is tested.
      exclude: ['src/index.ts'],

      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage',

      /**
       * ≥90%, per CLAUDE.md's quality floors.
       *
       * Thresholds live here rather than in a shell pipeline so that `vitest run
       * --coverage` fails on its own — a gate that only exists inside a Makefile recipe
       * is a gate that is off whenever someone runs the tests directly.
       */
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 90,
      },
    },
  },
})
