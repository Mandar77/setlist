/**
 * Deduplication, and the affix tables the parsers strip before it.
 *
 * Ported from `tools/oracle-py/tests/test_dedupe.py` and the affix half of
 * `test_parsers.py` (ADR-001). Both are list-shaped: ten bullet characters, six ordinal
 * separators, a punctuation set to right-strip. The differential exercises whichever
 * ones the corpus happens to contain.
 */

import { describe, expect, it } from 'vitest'

import { dedupe } from '../src/dedupe.js'
import { ExtractionMethod, Qualifier } from '../src/enums.js'
import {
  makeHints,
  makeLine,
  makeParsedItem,
  makeSpan,
  occurrenceCount,
  type Hints,
  type ParsedItem,
} from '../src/models.js'
import { stripPrefixes, stripSuffixes } from '../src/parsers/affixes.js'

const line = (text: string, offset = 0) => makeLine(text, offset)

let nextStart = 0
/** An item at a fresh span, so document order is the order they are built. */
function item(
  title: string,
  artist: string | null = null,
  confidence = 0.9,
  hints: Hints = makeHints(),
): ParsedItem {
  const start = (nextStart += 100)
  return makeParsedItem({
    title,
    artist,
    hints,
    span: makeSpan(start, start + 10),
    confidence,
    method: ExtractionMethod.DETERMINISTIC,
    parser: 'dash',
  })
}

// --------------------------------------------------------------------------- affixes
describe('every bullet character is stripped', () => {
  // Spelled out so deleting one from `BULLETS` fails exactly one case. A bullet left in
  // place becomes part of the title and the matcher looks for "• Genesis".
  it.each([
    ['hyphen', '-'],
    ['asterisk', '*'],
    ['bullet', '•'],
    ['triangular bullet', '‣'],
    ['middle dot', '·'],
    ['white bullet', '◦'],
    ['hyphen bullet', '⁃'],
    ['bullet operator', '∙'],
    ['angle quote', '>'],
    ['plus', '+'],
  ])('%s', (_label, bullet) => {
    expect(stripPrefixes(line(`${bullet} Genesis`)).line.text).toBe('Genesis')
  })

  it('but only when a space follows', () => {
    // "+44" is a band and "-1" could be a title. A bullet is a bullet because of the
    // space after it.
    expect(stripPrefixes(line('+44')).line.text).toBe('+44')
  })
})

describe('every ordinal separator is recognized', () => {
  it.each([
    ['a period', '1. Genesis'],
    ['a parenthesis', '1) Genesis'],
    ['a bracket', '1] Genesis'],
    ['a colon', '1: Genesis'],
    ['a hyphen', '1 - Genesis'],
    ['an en dash', '1 – Genesis'],
    ['an em dash', '1 — Genesis'],
  ])('%s', (_label, raw) => {
    const { line: stripped, hints } = stripPrefixes(line(raw))
    expect(stripped.text).toBe('Genesis')
    expect(hints.position).toBe(1)
  })

  // A bare "#2 Genesis" is deliberately not one: the ordinal regex requires a separator
  // after the digits, so a title like "#1 Crush" keeps its number.
  it.each([
    ['square brackets', '[2] Genesis'],
    ['parentheses', '(2) Genesis'],
    ['a hash and a period', '#2. Genesis'],
    ['a hash and a dash', '#2 - Genesis'],
  ])('%s', (_label, raw) => {
    const { line: stripped, hints } = stripPrefixes(line(raw))
    expect(stripped.text).toBe('Genesis')
    expect(hints.position).toBe(2)
  })
})

describe('trailing annotations are peeled from the right place', () => {
  it.each([
    ['parentheses', 'Artist - Title (3:45)'],
    ['square brackets', 'Artist - Title [3:45]'],
  ])('a duration in %s', (_label, raw) => {
    const { line: stripped, hints } = stripSuffixes(line(raw))
    expect(stripped.text).toBe('Artist - Title')
    expect(hints.durationS).toBe(225)
  })

  it.each([
    ['parentheses', 'Artist - Title (USRC17607839)'],
    ['square brackets', 'Artist - Title [USRC17607839]'],
  ])('an ISRC in %s', (_label, raw) => {
    expect(stripSuffixes(line(raw)).hints.isrc).toBe('USRC17607839')
  })

  it.each([' ', '.', ',', ';', '\t'])('right-strips a trailing %j', char => {
    expect(stripSuffixes(line(`Artist - Title${char}`)).line.text).toBe('Artist - Title')
  })

  it('leaves a trailing character that is not punctuation', () => {
    expect(stripSuffixes(line('Artist - Title!')).line.text).toBe('Artist - Title!')
  })
})

// ---------------------------------------------------------------------------- dedupe
describe('exact duplicates collapse', () => {
  it('merges items that share a key', () => {
    const merged = dedupe([item('Da Funk', 'Daft Punk'), item('Da Funk', 'Daft Punk')])
    expect(merged).toHaveLength(1)
    expect(occurrenceCount(merged[0]!)).toBe(2)
  })

  it('ignores case and punctuation when deciding', () => {
    const merged = dedupe([item('Da Funk!', 'Daft Punk'), item('da funk', 'DAFT PUNK')])
    expect(merged).toHaveLength(1)
  })

  it('keeps the highest-confidence occurrence', () => {
    const merged = dedupe([
      item('Da Funk', 'Daft Punk', 0.7),
      item('Da Funk', 'Daft Punk', 0.95),
      item('Da Funk', 'Daft Punk', 0.8),
    ])
    expect(merged[0]!.confidence).toBe(0.95)
  })

  it('breaks a tie with the earliest mention', () => {
    // Python's `max` keeps the first maximum. A port using `>=` would keep the last and
    // silently reorder output on every tied document, which is most of them.
    const first = item('Da Funk', 'Daft Punk', 0.9)
    const second = item('Da Funk', 'Daft Punk', 0.9)
    expect(dedupe([first, second])[0]!.span.start).toBe(first.span.start)
  })

  it('records every other occurrence in document order', () => {
    const a = item('Da Funk', 'Daft Punk', 0.9)
    const b = item('Da Funk', 'Daft Punk', 0.95)
    const c = item('Da Funk', 'Daft Punk', 0.8)
    const merged = dedupe([a, b, c])
    expect(merged[0]!.duplicates.map(s => s.start)).toEqual(
      [a.span.start, c.span.start].sort((x, y) => x - y),
    )
  })

  it('merges hints across occurrences', () => {
    const merged = dedupe([
      item('Da Funk', 'Daft Punk', 0.9, makeHints({ isrc: 'USRC17607839' })),
      item('Da Funk', 'Daft Punk', 0.8, makeHints({ durationS: 328 })),
    ])
    expect(merged[0]!.hints.isrc).toBe('USRC17607839')
    expect(merged[0]!.hints.durationS).toBe(328)
  })

  it('keeps a live recording separate from the studio cut', () => {
    // Qualifiers are part of the key. Collapsing them would silently drop one of the two
    // tracks the user actually listed.
    const merged = dedupe([
      item('Da Funk', 'Daft Punk'),
      item('Da Funk', 'Daft Punk', 0.9, makeHints({ qualifiers: [Qualifier.LIVE] })),
    ])
    expect(merged).toHaveLength(2)
  })

  it('keeps different artists separate', () => {
    expect(dedupe([item('Crazy', 'Gnarls Barkley'), item('Crazy', 'Seal')])).toHaveLength(2)
  })

  it('preserves first-appearance order', () => {
    const merged = dedupe([
      item('Da Funk', 'Daft Punk'),
      item('Genesis', 'Justice'),
      item('Da Funk', 'Daft Punk'),
    ])
    expect(merged.map(i => i.title)).toEqual(['Da Funk', 'Genesis'])
  })

  it('handles an empty input', () => {
    expect(dedupe([])).toEqual([])
  })
})

describe('an artistless mention folds into the attributed one', () => {
  it('absorbs it', () => {
    const merged = dedupe([item('Da Funk', 'Daft Punk'), item('Da Funk', null)])
    expect(merged).toHaveLength(1)
    expect(merged[0]!.artist).toBe('Daft Punk')
    expect(occurrenceCount(merged[0]!)).toBe(2)
  })

  it('carries the hints across', () => {
    const merged = dedupe([
      item('Da Funk', 'Daft Punk'),
      item('Da Funk', null, 0.55, makeHints({ durationS: 328 })),
    ])
    expect(merged[0]!.hints.durationS).toBe(328)
  })

  it('refuses when two artists claim the same title', () => {
    // "Crazy" with no artist, next to Gnarls Barkley's and Seal's: guessing would attach
    // the user's mention to the wrong song half the time.
    const merged = dedupe([
      item('Crazy', 'Gnarls Barkley'),
      item('Crazy', 'Seal'),
      item('Crazy', null),
    ])
    expect(merged).toHaveLength(3)
  })

  it('leaves an artistless item alone when nothing matches', () => {
    const merged = dedupe([item('Da Funk', 'Daft Punk'), item('Genesis', null)])
    expect(merged.map(i => i.artist)).toEqual(['Daft Punk', null])
  })

  it('matches on the folded title, not the literal one', () => {
    const merged = dedupe([item('Da Funk', 'Daft Punk'), item('da  funk!', null)])
    expect(merged).toHaveLength(1)
  })
})
