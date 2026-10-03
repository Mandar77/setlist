import { defineConfig } from 'vitest/config'

// Without this, `vitest run` also collects `dist/test/*.test.js` — the compiled output of
// the very same tests, left behind by `tsc --build`. Those copies resolve their imports
// from `dist/`, where the relative path to `infra/lib/config` no longer points anywhere,
// so they fail with a module-not-found that has nothing to do with the test.
//
// It was latent until M0A-05 made `pnpm -C tools/free-tier-estimate test` a verify
// command: nothing had run this package's tests directly before, so a stale build
// artifact had never had the chance to fail the suite.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
  },
})
