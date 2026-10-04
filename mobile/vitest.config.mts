import { defineConfig } from 'vitest/config'

/**
 * `pnpm -C mobile test`, which is the verify for M1-01 and M1-07.
 *
 * Its own config rather than the root one so running it from this directory runs this
 * package's tests and not the whole workspace. The root config also collects
 * `mobile/test/**`, so `make verify` covers these files too — the same suite, reached two
 * ways, which is what keeps the task's verify command honest about the gate.
 *
 * Nothing here needs a device. Everything that renders is a pure function of the core's
 * result; the emulator proves the screen is wired to it, and Maestro does that in CI.
 */
export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
    },
})
