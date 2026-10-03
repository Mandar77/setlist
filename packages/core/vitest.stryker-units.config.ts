import { defineConfig, mergeConfig } from 'vitest/config'

import base from './vitest.config.js'

/**
 * The hand-written suites only — no differentials at all.
 *
 * Used by `stryker.units.config.json`, the diagnostic run with no threshold. It answers
 * the question CORE-07 makes urgent: when the frozen oracle is retired and the
 * differentials go with it, will the tests a person actually reads still pin the
 * behaviour?
 *
 * The differentials are excluded here because they compare byte-for-byte against the
 * oracle's committed answers, so essentially every mutant that changes behaviour at all
 * dies against them. Fine for a gate, useless for a diagnostic: a number that cannot go
 * down measures nothing. The first run of this config said 39.88%, and the first thing
 * it found was a SHA-256 test that compared the function against itself.
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        'test/differential.test.ts',
        'test/pipeline-differential.test.ts',
        'test/pipeline-10k.test.ts',
      ],
      coverage: { enabled: false },
    },
  }),
)
