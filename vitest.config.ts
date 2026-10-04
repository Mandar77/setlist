import { defineConfig } from 'vitest/config'

/**
 * Where the tests are, stated rather than inferred.
 *
 * This file exists because the defaults changed underneath us. Vitest 2 ignored build
 * output; Vitest 5 collected it, so `tsc --build` emissions under `dist/` were run as a
 * second copy of every suite — 12 failures, all of them the compiled twin of a passing
 * test, failing because `budget.yaml` is not relative to `dist/`.
 *
 * That is a confusing way to find out, but the worse version is the one that does not
 * fail: a stale `dist/` copy of a deleted test going on passing, or a suite silently
 * counted twice. Naming the roots means the set of tests is a decision rather than a
 * consequence of whichever defaults the current major ships with.
 */
export default defineConfig({
  test: {
    /**
     * 30s, not the default 5s.
     *
     * The infra suites construct real CDK apps, and the first test in each file pays
     * the cost of loading aws-cdk-lib — which got slower between 2.173 and 2.272,
     * enough to cross 5s on a cold run. The symptom was a suite that failed about two
     * runs in three, always on whichever test happened to be first.
     *
     * Raising this is not loosening a gate: nothing here asserts on duration, and the
     * tests were passing whenever they got to run. A suite that fails intermittently
     * for a reason unrelated to the code is worse than a slow one, because the habit it
     * teaches is re-running until green.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,

    include: [
      'infra/{lib,nag,test,bootstrap}/**/*.test.ts',
      'packages/*/test/**/*.test.ts',
      'services/*/test/**/*.test.ts',
      'tools/*/test/**/*.test.ts',
      'web/**/*.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      // Build output. Everything here is a compiled copy of a file already in `include`.
      '**/dist/**',
      '**/cdk.out/**',
      '**/.venv/**',
      // Fixtures that must fail to compile or synthesize; they are driven by their own
      // checkers, not by vitest.
      'tools/toolchain-smoke/fixtures/**',
      'tests/fixtures/**',
      // The Chromium conformance runner downloads and launches a browser, which `make
      // verify` must not need — it has a five-minute budget and runs without Docker or
      // a browser. CORE-06 runs it through `pnpm -C packages/core test:conformance`,
      // after `playwright install chromium`, in its own CI job.
      'packages/core/test/conformance.browser.test.ts',
      // Same reason, for the OCR golden generator: it launches Chromium to draw the
      // corpus. `pnpm -C tools/golden-images test:render` runs it in its own CI job.
      'tools/golden-images/test/render.browser.test.ts',
    ],
  },
})
