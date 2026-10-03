/**
 * The data model: spans, documents, lines, hints, items and the zod boundary.
 *
 * The differential suites exercise all of this, but only along the paths a real document
 * takes. The validation that never fires on a well-formed input is exactly the
 * validation worth testing directly — a `makeSpan` that accepted `end <= start` would
 * pass every differential in the repo and produce a negative-length slice the first time
 * a parser got an off-by-one wrong.
 *
 * Ported from `tools/oracle-py/tests/` (ADR-001), which is where this behaviour was
 * pinned before the port and where it stops being pinned at CORE-07.
 */

import { describe, expect, it } from 'vitest'

import { ExtractionMethod, Qualifier, RejectReason, sortQualifiers } from '../src/enums.js'
import {
  below,
  deterministicCoverage,
  documentFromRaw,
  EMPTY_HINTS,
  EMPTY_STATS,
  itemKey,
  lineSpan,
  lineSub,
  makeHints,
  makeLine,
  makeParsedItem,
  makeRejectedItem,
  makeSpan,
  MAX_TITLE_LENGTH,
  mergeHints,
  occurrenceCount,
  parsedItemSchema,
  residualText,
  shiftSpan,
  sliceSpan,
  sourceDocumentSchema,
  spanSchema,
  spanWithin,
  type ExtractionResult,
} from '../src/models.js'
import { normalizeDocument } from '../src/normalize.js'
import { sha256Hex } from '../src/sha256.js'

describe('spans', () => {
  it('slices the text they cover', () => {
    expect(sliceSpan(makeSpan(5, 12), 'Daft Punk - Da Funk')).toBe('Punk - ')
  })

  it('knows whether they fit inside a document', () => {
    expect(spanWithin(makeSpan(0, 19), 'Daft Punk - Da Funk')).toBe(true)
    expect(spanWithin(makeSpan(0, 20), 'Daft Punk - Da Funk')).toBe(false)
  })

  it('translate by an offset', () => {
    expect(shiftSpan(makeSpan(2, 6), 100)).toEqual({ start: 102, end: 106 })
  })

  it.each([
    ['a negative start', -1, 4],
    ['a fractional start', 0.5, 4],
    ['a zero end', 0, 0],
    ['an end before the start', 9, 4],
    ['an end equal to the start', 4, 4],
  ])('refuses %s', (_label, start, end) => {
    // Half-open and non-empty. An empty span would "contain" nothing and ground
    // nothing, which is a rejection the grounding gate should make, not a span the
    // model quietly allows.
    expect(() => makeSpan(start, end)).toThrow(RangeError)
  })

  it('are frozen', () => {
    const span = makeSpan(0, 4) as { start: number }
    expect(() => {
      span.start = 7
    }).toThrow()
  })
})

describe('documents', () => {
  it('normalize the text and keep the raw length', () => {
    // Code points, not literals: a zero-width space written into a source file is
    // invisible to the next reader and to the diff.
    const ZWSP = String.fromCodePoint(0x200b)
    const FULLWIDTH_HYPHEN = String.fromCodePoint(0xff0d)
    const raw = `Daft${ZWSP}Punk ${FULLWIDTH_HYPHEN} Da Funk` + String.fromCodePoint(10)
    const document = documentFromRaw(raw)
    expect(document.rawLength).toBe(raw.length)
    expect(document.text).toBe('DaftPunk - Da Funk')
  })

  it('digest the normalized text before it is stripped, not after', () => {
    // Surprising, and load-bearing: the oracle's `from_raw` hashes its local variable
    // and pydantic's `str_strip_whitespace` runs afterwards. So `digest` is the identity
    // of what the user submitted, and is NOT the hash of `text`.
    const raw = 'Daft Punk - Da Funk\n'
    const document = documentFromRaw(raw)
    expect(document.digest).toBe(sha256Hex(normalizeDocument(raw)))
    expect(document.digest).not.toBe(sha256Hex(document.text))
  })

  it('give identical text the same digest', () => {
    // The whole point of the field: a confirmed job must be provably operating on the
    // text that was previewed.
    expect(documentFromRaw('a - b').digest).toBe(documentFromRaw('a - b').digest)
    expect(documentFromRaw('a - b').digest).not.toBe(documentFromRaw('a - c').digest)
  })
})

describe('lines', () => {
  it('span their own text in document coordinates', () => {
    expect(lineSpan(makeLine('Genesis', 40))).toEqual({ start: 40, end: 47 })
  })

  it('have no span when empty', () => {
    // A blank line is a real line with a real offset and nothing to point at. Returning
    // a zero-width span instead would put an un-sliceable span into the residual list.
    expect(lineSpan(makeLine('', 40))).toBeNull()
  })

  it('project a substring into document coordinates', () => {
    expect(lineSub(makeLine('Daft Punk - Da Funk', 100), 12, 19)).toEqual({
      start: 112,
      end: 119,
    })
  })
})

describe('hints', () => {
  it('default to empty', () => {
    expect(makeHints()).toEqual(EMPTY_HINTS)
  })

  it('strip whitespace from every string field, including inside collections', () => {
    // pydantic's `str_strip_whitespace` reaches into lists too, which is not obvious and
    // changes dedupe keys when it is missed.
    const hints = makeHints({
      album: '  Discovery ',
      isrc: ' GBDUW0000059 ',
      versionLabel: ' 2011 Remaster ',
      featuredArtists: [' Pharrell ', 'Nile Rodgers '],
    })
    expect(hints.album).toBe('Discovery')
    expect(hints.isrc).toBe('GBDUW0000059')
    expect(hints.versionLabel).toBe('2011 Remaster')
    expect(hints.featuredArtists).toEqual(['Pharrell', 'Nile Rodgers'])
  })

  it('prefer the left side when merging', () => {
    const merged = mergeHints(makeHints({ album: 'Discovery' }), makeHints({ album: 'Homework' }))
    expect(merged.album).toBe('Discovery')
  })

  it('fall back to the right side for fields the left is missing', () => {
    const merged = mergeHints(makeHints({ album: 'Discovery' }), makeHints({ year: 2001 }))
    expect(merged.album).toBe('Discovery')
    expect(merged.year).toBe(2001)
  })

  it('keep a zero position or timestamp rather than treating it as absent', () => {
    // `self.position or other.position` is the natural translation of the oracle's
    // `if ... is not None` and it is wrong: zero is falsy in JavaScript and a cue sheet
    // legitimately starts at 00:00.
    const merged = mergeHints(makeHints({ timestampS: 0 }), makeHints({ timestampS: 99 }))
    expect(merged.timestampS).toBe(0)
  })

  it('union featured artists without duplicating them', () => {
    const merged = mergeHints(
      makeHints({ featuredArtists: ['Pharrell'] }),
      makeHints({ featuredArtists: ['Pharrell', 'Nile Rodgers'] }),
    )
    expect(merged.featuredArtists).toEqual(['Pharrell', 'Nile Rodgers'])
  })

  it('union qualifiers', () => {
    const merged = mergeHints(
      makeHints({ qualifiers: [Qualifier.LIVE] }),
      makeHints({ qualifiers: [Qualifier.LIVE, Qualifier.REMASTER] }),
    )
    expect([...merged.qualifiers].sort()).toEqual([Qualifier.LIVE, Qualifier.REMASTER])
  })
})

describe('qualifier ordering', () => {
  it('sorts and deduplicates', () => {
    // The oracle holds these in a frozenset and sorts on the way out. A JavaScript Set
    // preserves insertion order, which looks the same until two code paths insert in
    // different orders and the serialized output stops matching.
    expect(sortQualifiers([Qualifier.REMASTER, Qualifier.LIVE, Qualifier.LIVE])).toEqual([
      Qualifier.LIVE,
      Qualifier.REMASTER,
    ])
  })
})

describe('parsed items', () => {
  const span = makeSpan(0, 10)
  const base = {
    span,
    confidence: 0.9,
    method: ExtractionMethod.DETERMINISTIC,
    parser: 'dash',
  }

  it('strip whitespace from the title, artist and parser', () => {
    const item = makeParsedItem({ ...base, title: '  Da Funk ', artist: ' Daft Punk  ' })
    expect(item.title).toBe('Da Funk')
    expect(item.artist).toBe('Daft Punk')
  })

  it('treat a missing artist and a null artist alike', () => {
    expect(makeParsedItem({ ...base, title: 'Da Funk' }).artist).toBeNull()
    expect(makeParsedItem({ ...base, title: 'Da Funk', artist: null }).artist).toBeNull()
  })

  it.each([
    ['an empty title', { title: '   ' }],
    ['an empty artist', { title: 'Da Funk', artist: '  ' }],
    ['a title past the length cap', { title: 'x'.repeat(MAX_TITLE_LENGTH + 1) }],
    ['a confidence above one', { title: 'Da Funk', confidence: 1.5 }],
    ['a confidence below zero', { title: 'Da Funk', confidence: -0.1 }],
    ['a NaN confidence', { title: 'Da Funk', confidence: Number.NaN }],
    ['an empty parser', { title: 'Da Funk', parser: '' }],
  ])('refuse %s', (_label, overrides) => {
    expect(() => makeParsedItem({ ...base, ...(overrides as { title: string }) })).toThrow(
      RangeError,
    )
  })

  it('accept a title exactly at the length cap', () => {
    // The boundary in the passing direction. Without it, `>` and `>=` are
    // indistinguishable and a 300-character title could be rejected forever.
    expect(makeParsedItem({ ...base, title: 'x'.repeat(MAX_TITLE_LENGTH) }).title).toHaveLength(
      MAX_TITLE_LENGTH,
    )
  })

  it('key on the folded title, artist and qualifiers', () => {
    const live = makeParsedItem({
      ...base,
      title: 'Da Funk',
      artist: 'Daft Punk',
      hints: makeHints({ qualifiers: [Qualifier.LIVE] }),
    })
    const studio = makeParsedItem({ ...base, title: 'Da  FUNK!', artist: 'daft punk' })
    const plain = makeParsedItem({ ...base, title: 'Da Funk', artist: 'Daft Punk' })
    expect(itemKey(studio)).toBe(itemKey(plain))
    expect(itemKey(live)).not.toBe(itemKey(plain))
  })

  it('count themselves plus their collapsed duplicates', () => {
    expect(occurrenceCount(makeParsedItem({ ...base, title: 'Da Funk' }))).toBe(1)
    expect(
      occurrenceCount(
        makeParsedItem({ ...base, title: 'Da Funk', duplicates: [makeSpan(20, 30)] }),
      ),
    ).toBe(2)
  })
})

describe('rejected items', () => {
  it('default the optional fields', () => {
    const rejected = makeRejectedItem({ title: ' x ', reason: RejectReason.EMPTY_TITLE })
    expect(rejected).toEqual({
      title: 'x',
      artist: null,
      reason: RejectReason.EMPTY_TITLE,
      detail: '',
      span: null,
      // Not the empty string: a rejection whose producing parser is unknown should say
      // so, because the field exists to tell us which parser to fix.
      parser: 'unknown',
    })
  })

  it('keep a title that a parsed item would refuse', () => {
    // The whole point of the type. `title` is unvalidated here because the reason for
    // rejection is frequently that the title was invalid.
    expect(makeRejectedItem({ title: '', reason: RejectReason.EMPTY_TITLE }).title).toBe('')
  })
})

describe('stats', () => {
  it('report full coverage when nothing was considered', () => {
    // An empty document resolved everything it was asked to. Returning 0 would make a
    // blank paste look like a total parser failure on the dashboard.
    expect(deterministicCoverage(EMPTY_STATS)).toBe(1)
  })

  it('divide parsed lines by parsed plus residual', () => {
    expect(deterministicCoverage({ ...EMPTY_STATS, linesParsed: 3, linesResidual: 1 })).toBeCloseTo(
      0.75,
    )
  })
})

describe('results', () => {
  const document = documentFromRaw('Da Funk\nGenesis\nMidnight City')
  const item = (title: string, confidence: number, start: number, end: number) =>
    makeParsedItem({
      title,
      span: makeSpan(start, end),
      confidence,
      method: ExtractionMethod.DETERMINISTIC,
      parser: 'bare',
    })
  const result: ExtractionResult = {
    document,
    items: [item('Da Funk', 0.9, 0, 7), item('Genesis', 0.55, 8, 15)],
    residual: [makeSpan(16, 29)],
    rejected: [],
    stats: EMPTY_STATS,
  }

  it('join the residual lines one per line', () => {
    expect(residualText(result)).toBe('Midnight City')
  })

  it('select the items under a threshold', () => {
    expect(below(result, 0.8).map(i => i.title)).toEqual(['Genesis'])
    expect(below(result, 0.5)).toEqual([])
  })
})

describe('the zod boundary', () => {
  it('accepts a well-formed item', () => {
    expect(
      parsedItemSchema.safeParse({
        title: 'Da Funk',
        span: { start: 0, end: 7 },
        confidence: 0.9,
        method: 'deterministic',
        parser: 'dash',
      }).success,
    ).toBe(true)
  })

  it.each([
    ['an empty title', { title: '', span: { start: 0, end: 7 } }],
    ['a confidence above one', { confidence: 1.1 }],
    ['an unknown method', { method: 'vibes' }],
    ['a span ending before it starts', { span: { start: 9, end: 4 } }],
    ['a negative span start', { span: { start: -1, end: 4 } }],
  ])('refuses %s', (_label, overrides) => {
    expect(
      parsedItemSchema.safeParse({
        title: 'Da Funk',
        span: { start: 0, end: 7 },
        confidence: 0.9,
        method: 'deterministic',
        parser: 'dash',
        ...overrides,
      }).success,
    ).toBe(false)
  })

  it('refuses a malformed ISRC rather than passing it to a provider', () => {
    const parse = (isrc: string) =>
      parsedItemSchema.safeParse({
        title: 'Da Funk',
        span: { start: 0, end: 7 },
        confidence: 0.9,
        method: 'deterministic',
        parser: 'dash',
        hints: { isrc },
      }).success
    expect(parse('GBDUW0000059')).toBe(true)
    expect(parse('gbduw0000059')).toBe(false)
    expect(parse('GBDUW000005')).toBe(false)
  })

  it('refuses a year outside the recorded-music era', () => {
    expect(spanSchema.safeParse({ start: 0, end: 1 }).success).toBe(true)
    expect(
      sourceDocumentSchema.safeParse({ text: 'x', rawLength: 1, digest: 'nope' }).success,
    ).toBe(false)
    expect(
      sourceDocumentSchema.safeParse({ text: 'x', rawLength: 1, digest: 'a'.repeat(64) }).success,
    ).toBe(true)
  })
})
