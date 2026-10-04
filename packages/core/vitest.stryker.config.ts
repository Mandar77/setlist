import { defineConfig, mergeConfig } from 'vitest/config'

import base from './vitest.config.js'

/**
 * The suite the mutation gate runs against: everything except `pipeline-10k.test.ts`.
 *
 * Not a preference — a measurement. Stryker instruments every statement in the core, and
 * under that instrumentation ten thousand whole-pipeline runs plus ten thousand SHA-256
 * digests blow through any sane per-test timeout; the first attempt failed Stryker's own
 * dry run at 30 s. Raising the timeout would be the worse outcome, because a mutant that
 * merely made the core slower would then be scored "killed by timeout" and the mutation
 * score would quietly start measuring performance instead of test strength.
 *
 * Everything else is included, the 4,903-case function-level diff and the eight golden
 * end-to-end cases among it. An earlier version of this file excluded those too, on the
 * theory that a byte-for-byte oracle comparison kills every mutant and so measures the
 * oracle rather than the tests. True, but it is not a reason to leave real tests out of
 * the package's own gate; that question is asked separately and without a threshold by
 * `stryker.units.config.json`.
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        'test/pipeline-10k.test.ts',
        'test/conformance.browser.test.ts',
      ],
      coverage: { enabled: false },
    },
  }),
)
