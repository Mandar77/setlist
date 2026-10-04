// CORE-06, the Chromium half.
//
// ADR-001 calls engine divergence "the most likely source of a real divergence" and names
// the suspects: NFKC and regex Unicode property escapes. Node and Chromium both run V8,
// so this is not expected to find much — its job is to make the claim checkable rather
// than assumed, and to be the harness M1-04 copies for Hermes, which is the engine where
// the divergence is actually likely.
//
// The suite is not reimplemented here. `src/conformance.ts` is bundled with esbuild and
// evaluated in the page, so Chromium runs the identical function Node just ran; the only
// thing this file contributes is the data and the browser.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { ConformanceReport } from '../src/conformance.js'
import { conformanceCases } from './conformance.test.js'

/**
 * Bundle the suite into something a page can evaluate.
 *
 * IIFE rather than ESM: `page.evaluate` takes a function or an expression, not a module,
 * and an IIFE that assigns to a global is the least surprising way to get one in.
 */
async function bundleSuite(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'setlist-conformance-'))
  const entry = join(dir, 'entry.ts')
  const out = join(dir, 'bundle.js')

  // fileURLToPath, not `.pathname` — the first attempt used the latter and esbuild could
  // not resolve the entry, because this repository lives under "OneDrive - Northeastern
  // University" and a URL pathname percent-encodes the spaces. Hand-rolling the
  // conversion gets the drive letter right and the spaces wrong.
  const here = dirname(fileURLToPath(import.meta.url))
  writeFileSync(
    entry,
    [
      `import { runConformance } from ${JSON.stringify(join(here, '..', 'src', 'conformance.ts'))}`,
      'globalThis.__setlistConformance = runConformance',
    ].join('\n'),
  )

  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    outfile: out,
  })
  return readFileSync(out, 'utf8')
}

describe('engine conformance on Chromium', () => {
  let report: ConformanceReport
  let cases: ReturnType<typeof conformanceCases>

  beforeAll(async () => {
    cases = conformanceCases()
    const bundle = await bundleSuite()
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.addScriptTag({ content: bundle })
      report = (await page.evaluate(
        (input: unknown) =>
          (globalThis as unknown as Record<string, (...args: unknown[]) => unknown>)[
            '__setlistConformance'
          ]!(input, 'chromium'),
        cases,
      )) as ConformanceReport
    } finally {
      await browser.close()
    }
  }, 180_000)

  afterAll(() => {
    if (report) console.log(`chromium: ${report.passed}/${report.total} golden cases`)
  })

  it('ran in Chromium and not by accident in Node', () => {
    expect(report.engine).toBe('chromium')
    expect(report.total).toBe(cases.length)
    expect(report.total).toBeGreaterThan(0)
  })

  it('reproduces every frozen oracle output', () => {
    if (report.failures.length > 0) {
      console.log(JSON.stringify(report.failures.slice(0, 2), null, 2))
    }
    expect(report.failures).toEqual([])
  })

  it('has the NFKC and property-escape behaviour the core depends on', () => {
    expect(report.unicode).toEqual([])
  })

  it('agrees with Node, case for case', () => {
    expect(report.passed).toBe(cases.length)
    expect(report.ok).toBe(true)
  })
})
