/**
 * The differential: our CER and WER must equal jiwer's, case for case.
 *
 * [ADR-014](../../../docs/adr/0014-ocr-metrics-oracle.md). `oracle-py` computes jiwer's
 * answers for `golden/metric-cases.json` and commits them; this reads both files and
 * asserts they agree. The M2 exit gate is written in terms of these numbers, and a
 * hand-written Levenshtein ratio does not fail when it is wrong — it returns a plausible
 * number. This is what stops that.
 *
 * It has already earned it. Three divergences were found the first time it ran, two of
 * which would have shipped:
 *
 *   * jiwer's default word splitter splits on spaces and **not newlines**, making
 *     `'line one\nline two'` three words;
 *   * its default CER strips the ends of a string but keeps internal whitespace runs;
 *   * an empty reference returns a guarded `errors / 1`, not an exception and not
 *     `Infinity`.
 *
 * The first two are resolved by stating the transform explicitly on both sides rather
 * than inheriting a default; the third by matching the convention. All three are now
 * pinned here.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { cer, wer } from '../src/metrics.js'

const goldenDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'golden')

interface Case {
  readonly name: string
  readonly reference: string
  readonly hypothesis: string
}
interface Expected {
  readonly name: string
  readonly cer: number
  readonly wer: number
}

const cases: Case[] = JSON.parse(readFileSync(join(goldenDir, 'metric-cases.json'), 'utf8')).cases
const oracle: { jiwer: string; results: Expected[] } = JSON.parse(
  readFileSync(join(goldenDir, 'metric-expected.json'), 'utf8'),
)

describe(`CER and WER agree with jiwer ${oracle.jiwer}`, () => {
  it('has cases to check, so this suite cannot pass vacuously', () => {
    // The failure this guards: a corpus that fails to load leaves `it.each` with nothing
    // to iterate, and a differential over zero cases is a green test that proves nothing.
    expect(cases.length).toBeGreaterThan(10)
    expect(oracle.results).toHaveLength(cases.length)
  })

  it('pairs every case with an expectation, by name', () => {
    // Positional pairing would silently mis-grade every case after an insertion in the
    // middle of the fixture file, and each one would still be comparing two real numbers.
    expect(oracle.results.map(r => r.name)).toEqual(cases.map(c => c.name))
  })

  for (const testCase of cases) {
    const expectation = oracle.results.find(result => result.name === testCase.name)!

    it(`${testCase.name}`, () => {
      // Single-element arrays: these fixtures are whole strings including their newlines,
      // and `cer`/`wer` join with `\n`, so wrapping each in one element passes the string
      // through unchanged. Splitting on `\n` here would re-join it identically but would
      // make the fixture file's escaping load-bearing for no reason.
      expect(cer([testCase.reference], [testCase.hypothesis]).rate).toBeCloseTo(expectation.cer, 10)
      expect(wer([testCase.reference], [testCase.hypothesis]).rate).toBeCloseTo(expectation.wer, 10)
    })
  }
})
