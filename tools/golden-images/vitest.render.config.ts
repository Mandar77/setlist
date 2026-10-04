import { defineConfig } from 'vitest/config'

/**
 * The browser half of the OCR generator, run on its own.
 *
 * Same arrangement as `packages/core/vitest.conformance.config.ts`: the root config
 * excludes this suite so `make verify` never needs a browser, and CI runs it in a job
 * that has installed Chromium. Launching a browser costs more than the five-minute
 * budget allows and `make verify` must work without one.
 */
export default defineConfig({
  test: {
    include: ['test/render.browser.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
