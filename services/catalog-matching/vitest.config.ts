import { defineConfig } from 'vitest/config'

// Without this, `vitest run` also collects `dist/test/*.test.js` — the compiled copies
// that `tsc --build` leaves behind. They resolve their imports from `dist/`, where the
// relative paths no longer point anywhere, so they fail for reasons that have nothing to
// do with the test.
//
// The root config excludes `**/dist/**` already, so `make verify` never saw it; the
// package-local run is what trips over it. This is the second package to hit it
// (tools/free-tier-estimate was the first), which makes it a pattern rather than an
// accident: any package whose own `test` script is a verify command needs this.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
  },
})
