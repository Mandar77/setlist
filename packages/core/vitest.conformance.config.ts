import { defineConfig } from 'vitest/config'

/**
 * CORE-06's own config: the two conformance runners and nothing else.
 *
 * It exists because `vitest.config.ts` EXCLUDES the Chromium runner, and an exclude wins
 * over a filename passed on the command line — naming the file in the script ran seven
 * tests instead of eleven and looked like a pass. The default run has to skip it, since
 * `make verify` must not need a browser; this run has to include it, since it is the
 * whole point.
 *
 * The browser download is the caller's job: CI runs `playwright install chromium` first.
 */
export default defineConfig({
  test: {
    include: ['test/conformance.test.ts', 'test/conformance.browser.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Launching Chromium and bundling the suite takes longer than the default hook
    // timeout allows on a cold cache.
    hookTimeout: 180_000,
    testTimeout: 60_000,
  },
})
