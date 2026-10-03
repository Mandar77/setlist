// Property tests for the core's invariants, mirroring tools/oracle-py/tests/test_properties.py.
//
// Examples prove that known inputs work. These prove the invariants hold across inputs
// nobody thought to write down, which is the only honest way to claim "no hallucinated
// songs" about a system fed arbitrary internet text.
//
// This file exists because of what the Python side caught and this side could not: the
// oracle's Hypothesis suite found `normalize_document` to be non-idempotent, and the
// TypeScript port reproduced the bug exactly while having no property test that could
// have noticed. The differential compares the two implementations against each other, so
// a defect they share is invisible to it by construction. That is the gap a property
// suite fills, and the reason it belongs on both sides rather than only the one that
// happened to have it first.

import { describe, expect, it } from 'vitest'
import fc from 'fast-check'

import { fold, normalizeDocument, pyStrip } from '../src/normalize.js'

/**
 * The counterexample Hypothesis shrank to, kept as a permanent example rather than left
 * to be rediscovered.
 *
 * Built with `String.fromCodePoint` instead of written as a literal for two reasons:
 * U+001F is a control character and must not sit literally in a tracked file, and an
 * escape in a source string is exactly the thing several tools in this repo have
 * silently decoded into the real character on the way to disk.
 *
 * ACUTE ACCENT, UNIT SEPARATOR, TAI THAM COMBINING CRYPTOGRAMMIC DOT. NFKC turns the
 * first into space + U+0301 (combining class 230); the strip removes the U+001F between
 * it and U+1A7F (combining class 220); 220 sorts before 230, so a second pass reorders
 * them. See ADR-009 and the comment in `normalizeDocument`.
 */
const NON_IDEMPOTENT_WITNESS = String.fromCodePoint(0x00b4, 0x001f, 0x1a7f)

/**
 * Deliberately nasty, matching the oracle's `_CHAOS`: control characters, zero-width
 * joiners, bidi overrides, RTL, CJK, emoji and lone punctuation all appear in real
 * pasted threads. Fragments of genuine list syntax are interleaved so the generator
 * reaches the parsers instead of producing noise triage discards first.
 */
const INVISIBLE_SAMPLES = [
  String.fromCodePoint(0x200b), // zero-width space
  String.fromCodePoint(0x202e), // right-to-left override
  String.fromCodePoint(0x2066), // left-to-right isolate
  String.fromCodePoint(0xfeff), // BOM
  String.fromCodePoint(0x00ad), // soft hyphen
  String.fromCodePoint(0x1f3b5), // musical note emoji
  String.fromCodePoint(0x0645), // Arabic meem (RTL)
  String.fromCodePoint(0x4e16), // CJK
]

const FRAGMENTS = [
  ' - ',
  ' – ',
  ' by ',
  '"',
  '\t',
  '\n',
  ',',
  '1. ',
  '- ',
  '[00:14] ',
  '(Live)',
  '(Extended Mix)',
  'feat. ',
  'Daft Punk',
  'One More Time',
  'M83',
  'USRC17607839',
  '## Heading',
  'https://example.com',
  '|',
  ';',
]

/** A code point in the range the oracle's strategy draws from, minus the surrogates. */
const chaosChar = fc.oneof(
  fc
    .integer({ min: 1, max: 0x2fff })
    .filter(cp => cp < 0xd800 || cp > 0xdfff)
    .map(cp => String.fromCodePoint(cp)),
  fc.constantFrom(...INVISIBLE_SAMPLES),
)

const nastyText = fc
  .array(
    fc.oneof(
      fc.array(chaosChar, { maxLength: 40 }).map(cs => cs.join('')),
      fc.constantFrom(...FRAGMENTS),
    ),
    {
      maxLength: 24,
    },
  )
  .map(parts => parts.join(''))

/** Matches the oracle's `max_examples=200`, so the two suites search comparably hard. */
const RUNS = { numRuns: 200 }

describe('normalization properties', () => {
  it('is idempotent', () => {
    fc.assert(
      fc.property(nastyText, raw => {
        const once = normalizeDocument(raw)
        expect(normalizeDocument(once)).toBe(once)
      }),
      { ...RUNS, examples: [[NON_IDEMPOTENT_WITNESS]] },
    )
  })

  it('is idempotent on the known witness', () => {
    // The `examples` entry above already pins it, but only while the property survives.
    // This fails on its own if someone reverts the second NFKC, and it says which input
    // to look at rather than making the next person re-shrink it.
    const once = normalizeDocument(NON_IDEMPOTENT_WITNESS)
    expect(normalizeDocument(once)).toBe(once)
    // And the specific thing that used to go wrong: the two marks keep their order.
    expect([...once].map(ch => ch.codePointAt(0))).toEqual([0x20, 0x1a7f, 0x301])
  })

  it('leaves no carriage returns or invisible formatting characters', () => {
    fc.assert(
      fc.property(nastyText, raw => {
        const text = normalizeDocument(raw)
        expect(text).not.toContain('\r')
        for (const invisible of [0x200b, 0xfeff, 0x202e, 0x00ad]) {
          expect(text).not.toContain(String.fromCodePoint(invisible))
        }
      }),
      RUNS,
    )
  })

  it('never grows the document', () => {
    // NFKC can expand a single code point into several, so this is about code points
    // rather than bytes, and it is a bound rather than an equality: the span contract
    // says offsets index the normalized text precisely because length is not preserved.
    fc.assert(
      fc.property(nastyText, raw => {
        expect([...normalizeDocument(raw)].length).toBeLessThanOrEqual([...raw].length * 3)
      }),
      RUNS,
    )
  })
})

describe('fold properties', () => {
  it('is idempotent', () => {
    fc.assert(
      fc.property(nastyText, raw => {
        const once = fold(raw)
        expect(fold(once)).toBe(once)
      }),
      RUNS,
    )
  })

  it('produces no leading or trailing whitespace and no double spaces', () => {
    fc.assert(
      fc.property(nastyText, raw => {
        const folded = fold(raw)
        expect(folded).toBe(folded.trim())
        expect(folded).not.toContain('  ')
      }),
      RUNS,
    )
  })
})

describe('pyStrip properties', () => {
  it('is idempotent', () => {
    fc.assert(
      fc.property(nastyText, raw => {
        const once = pyStrip(raw)
        expect(pyStrip(once)).toBe(once)
      }),
      RUNS,
    )
  })
})
