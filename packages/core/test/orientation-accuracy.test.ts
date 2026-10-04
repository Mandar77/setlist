// CORE-05's accuracy floor: parser-only orientation on bare-dash lines.
//
// A bare dash line is the hard case and the reason ADR-002 exists. "Nina Simone ~ If You
// Knew" and "If You Knew ~ Nina Simone" are the same shape, and nothing inside the line
// says which is which — the answer has to come from the document around it or from how
// the document arrived.
//
// "Parser-only" is the operative qualifier. ADR-002 step 5 resolves the remainder against
// free catalogs before any YouTube quota is spent; this measures what the deterministic
// core gets right BEFORE any of that, because that is the number that decides how much
// catalog work there is to do.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { SourceKind } from '../src/enums.js'
import { extractDeterministic } from '../src/pipeline.js'
import { repoRoot } from './support/repo-root.js'

interface GoldenCase {
  readonly id: string
  readonly source: string
  readonly tier: string
  readonly text: string
  readonly expected: readonly { readonly title: string; readonly artist: string | null }[]
}

const corpus = JSON.parse(
  readFileSync(join(repoRoot, 'golden', 'extraction', 'generated.json'), 'utf8'),
) as { cases: GoldenCase[] }

const bareDash = corpus.cases.filter(c => c.id.startsWith('bare-dash'))

/** CORE-05's floor. */
const FLOOR = 0.9

describe('orientation accuracy on bare-dash lines', () => {
  it('has a corpus to measure — an empty filter would report 100%', () => {
    // The control. Every assertion below divides by this, and 0/0 is the one result that
    // would look like a pass while measuring nothing.
    expect(bareDash.length).toBeGreaterThanOrEqual(20)
    expect(bareDash.every(c => c.tier === 'clean')).toBe(true)
  })

  it(`is at least ${FLOOR * 100}% across the generated set`, () => {
    let correct = 0
    let total = 0
    const wrong: string[] = []

    for (const testCase of bareDash) {
      // Every bare-dash case is a pasted setlist, which is the source kind the ingestion
      // contract would carry for it.
      const result = extractDeterministic(testCase.text, { sourceKind: SourceKind.PASTE })
      const byTitle = new Map(result.items.map(item => [item.title, item.artist]))

      for (const expectation of testCase.expected) {
        total += 1
        if (byTitle.get(expectation.title) === expectation.artist) correct += 1
        else wrong.push(`${testCase.id}: ${expectation.artist} - ${expectation.title}`)
      }
    }

    const accuracy = correct / total
    // Printed so a regression says how far it fell, not merely that it did.
    console.log(
      `orientation accuracy: ${(accuracy * 100).toFixed(1)}% (${correct}/${total}), ` +
        `${wrong.length} wrong`,
    )
    if (wrong.length > 0) console.log(`first misses:\n  ${wrong.slice(0, 5).join('\n  ')}`)

    expect(total).toBeGreaterThan(50)
    expect(accuracy).toBeGreaterThanOrEqual(FLOOR)
  })

  it('the ladder actually decided these, rather than the parser default agreeing', () => {
    // Without this the headline number would pass even if `applyOrientation` were a
    // no-op, because the artist-first parser default happens to be right for this
    // corpus. What is being measured has to be the thing under test.
    const verdicts = bareDash.map(
      c => extractDeterministic(c.text, { sourceKind: SourceKind.PASTE }).orientation,
    )
    expect(verdicts.every(v => v !== null)).toBe(true)
    expect(verdicts.filter(v => v?.basis === 'convention').length).toBeGreaterThan(0)
  })
})
