// CORE-06, the Node half: the conformance suite run on this engine.
//
// The suite itself lives in `src/conformance.ts` and takes its cases as an argument, so
// the identical code runs in Chromium (test/conformance.browser.ts) and later on Hermes
// (M1-04). This file is only the Node runner: it reads `golden/oracle/`, hands the cases
// over, and asserts the report is clean.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  canonicalJson,
  renderOracleShape,
  runConformance,
  unicodeConformance,
  type ConformanceCase,
} from '../src/conformance.js'
import { extractDeterministic } from '../src/pipeline.js'
import { ORACLE_DIR, frozenOutputs, handWrittenCases, render } from './support/oracle-shape.js'

/** Build the cases the suite consumes, from the frozen oracle outputs. */
export function conformanceCases(): ConformanceCase[] {
  const texts = handWrittenCases()
  const cases: ConformanceCase[] = []

  for (const file of frozenOutputs()) {
    const expected = JSON.parse(readFileSync(join(ORACLE_DIR, file), 'utf8')) as {
      source_kind: string
      document: { text: string }
    }
    const name = file.replace(/\.json$/, '')
    const text = texts.get(name)
    if (text === undefined) throw new Error(`no hand-written case named ${name}`)
    cases.push({
      name,
      text,
      sourceKind: expected.source_kind,
      expected: canonicalJson(expected),
    })
  }
  return cases
}

describe('engine conformance on Node', () => {
  const cases = conformanceCases()

  it('has cases to run — an empty set would report a clean sweep of nothing', () => {
    expect(cases).toHaveLength(8)
  })

  it('reproduces every frozen oracle output', () => {
    const report = runConformance(cases, 'node')
    if (!report.ok) console.log(JSON.stringify(report.failures.slice(0, 2), null, 2))
    expect(report.failures).toEqual([])
    expect(report.passed).toBe(cases.length)
    expect(report.ok).toBe(true)
  })

  it('refuses to call an empty case list a pass', () => {
    // The control, and the reason `ok` is not just `failures.length === 0`. A runner
    // that failed to load its data is the single most repeated bug in this repository.
    const empty = runConformance([], 'node')
    expect(empty.failures).toEqual([])
    expect(empty.ok).toBe(false)
  })

  it('reports a mismatch rather than throwing', () => {
    const corrupted = cases.map(c => ({ ...c, expected: '{"schema":999}' }))
    const report = runConformance(corrupted, 'node')
    expect(report.ok).toBe(false)
    expect(report.failures).toHaveLength(cases.length)
    expect(report.failures[0]?.reason).toBe('output differs')
  })
})

describe('Unicode behaviour this engine must have (ADR-001)', () => {
  it('passes every NFKC and property-escape check', () => {
    expect(unicodeConformance()).toEqual([])
  })

  it('the NFKC composition check is not vacuous', () => {
    // The first draft of these checks was written with escapes, the formatter rewrote
    // them into the characters they stand for, and `e + combining acute` became a
    // precomposed e-acute — so the assertion compared a string to itself. This pins the
    // operands as the two DIFFERENT strings they have to be.
    const decomposed = String.fromCodePoint(0x65, 0x301)
    const composed = String.fromCodePoint(0xe9)
    expect(decomposed).not.toBe(composed)
    expect(decomposed.normalize('NFKC')).toBe(composed)
  })
})

describe('the two renderers agree', () => {
  // `src/conformance.ts` carries its own copy of the oracle-shape renderer, because a
  // browser or Hermes bundle cannot reach `test/support`. Two copies drift, and a drifted
  // renderer would make this whole suite measure the wrong shape while still passing.
  it('produce identical canonical JSON for every golden case', () => {
    for (const testCase of conformanceCases()) {
      const result = extractDeterministic(testCase.text, {
        sourceKind: testCase.sourceKind as never,
      })
      expect(canonicalJson(renderOracleShape(result, testCase.sourceKind))).toBe(
        canonicalJson(render(result, testCase.sourceKind)),
      )
    }
  })
})
