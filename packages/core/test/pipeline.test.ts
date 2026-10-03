/**
 * The pipeline end to end, and the confidence scoring it hands out.
 *
 * Ported from `tools/oracle-py/tests/test_pipeline.py` (ADR-001). The golden-case
 * differential covers eight whole documents; this covers the edges a real document
 * rarely reaches — the size cap, empty input, and each confidence adjustment on its own.
 */

import { describe, expect, it } from 'vitest'

import {
  AUTO_ACCEPT_THRESHOLD,
  BASE_CONFIDENCE,
  BONUS_DURATION,
  BONUS_ISRC,
  BONUS_STRUCTURED,
  clamp,
  deterministicConfidence,
  methodCeiling,
  PENALTY_AMBIGUOUS_DIRECTION,
  PENALTY_DEGENERATE_TITLE,
  PENALTY_NO_ARTIST,
  PENALTY_SHORT_TITLE,
  REVIEW_THRESHOLD,
} from '../src/confidence.js'
import { ExtractionMethod } from '../src/enums.js'
import { below, documentFromRaw, EMPTY_HINTS, makeHints } from '../src/models.js'
import {
  DEFAULT_MAX_INPUT_BYTES,
  extractDeterministic,
  InputTooLargeError,
} from '../src/pipeline.js'

describe('the input size cap', () => {
  it('rejects an oversized document', () => {
    // FR-001/NFR-004. A paste that never reaches the parsers is the cheapest possible
    // rejection and the only one that bounds the work.
    expect(() => extractDeterministic('x'.repeat(DEFAULT_MAX_INPUT_BYTES + 1))).toThrow(
      InputTooLargeError,
    )
  })

  it('reports the size and the limit it broke', () => {
    try {
      extractDeterministic('Daft Punk - Da Funk', { maxInputBytes: 5 })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(InputTooLargeError)
      expect((error as InputTooLargeError).limit).toBe(5)
      expect((error as InputTooLargeError).size).toBe(19)
    }
  })

  it('counts UTF-8 bytes, not characters', () => {
    // A document of CJK titles is three bytes per character, so a character count would
    // let it be three times the intended size — and the cap exists to bound a request
    // body, which is measured in bytes.
    expect(() => extractDeterministic('世'.repeat(10), { maxInputBytes: 20 })).toThrow(
      InputTooLargeError,
    )
    expect(() => extractDeterministic('x'.repeat(10), { maxInputBytes: 20 })).not.toThrow()
  })

  it('does not apply to an already-normalized document', () => {
    // It passed the gate at ingest; re-checking would mean re-measuring on every
    // internal call for no benefit.
    const document = documentFromRaw('Daft Punk - Da Funk')
    expect(() => extractDeterministic(document, { maxInputBytes: 5 })).not.toThrow()
  })
})

describe('degenerate input', () => {
  it.each(['', '   ', '\n\n\n', '---\n***\n', '|||'])('produces nothing from %j', text => {
    const result = extractDeterministic(text)
    expect(result.items).toEqual([])
    expect(result.residual).toEqual([])
  })
})

describe('a parsed document', () => {
  const result = extractDeterministic(
    [
      '# Best of the weekend',
      '1. Daft Punk - One More Time',
      '2. Justice - Genesis',
      '"Midnight City" by M83',
      'Honestly I have never heard a crowd react to anything like that before.',
      '1. Daft Punk - One More Time',
    ].join('\n'),
  )

  it('extracts every listed track', () => {
    expect(result.items.map(i => i.title)).toEqual(['One More Time', 'Genesis', 'Midnight City'])
  })

  it('collapses a repeated track and remembers where it was', () => {
    expect(result.items[0]!.duplicates).toHaveLength(1)
  })

  it('drops a markdown heading entirely rather than sending it to the LLM', () => {
    // Noise is dropped; prose is forwarded. Conflating them either loses songs or spends
    // Bedrock tokens on a heading.
    const residual = result.residual.map(s => result.document.text.slice(s.start, s.end))
    expect(residual).not.toContain('# Best of the weekend')
  })

  it('forwards prose as residual rather than parsing it', () => {
    const residual = result.residual.map(s => result.document.text.slice(s.start, s.end))
    expect(residual).toContain(
      'Honestly I have never heard a crowd react to anything like that before.',
    )
  })

  it('grounds every item in its own span', () => {
    for (const item of result.items) {
      expect(result.document.text.slice(item.span.start, item.span.end)).toContain(item.title)
    }
  })

  it('marks every item deterministic', () => {
    expect(result.items.every(i => i.method === ExtractionMethod.DETERMINISTIC)).toBe(true)
  })

  it('keeps its own counters consistent', () => {
    expect(result.stats.itemsAfterDedupe).toBe(result.items.length)
    expect(result.stats.linesParsed + result.stats.linesResidual).toBeLessThanOrEqual(
      result.stats.linesTotal,
    )
  })

  it('scores a quoted title above a dashed one', () => {
    // Base confidence reflects how unambiguous a pattern is, not how often it fires.
    const quoted = result.items.find(i => i.parser === 'quoted')!
    const dash = result.items.find(i => i.parser === 'dash')!
    expect(quoted.confidence).toBeGreaterThan(dash.confidence)
  })
})

describe('confidence', () => {
  const score = (
    parser: string,
    title: string,
    artist: string | null,
    hints = EMPTY_HINTS,
    options = {},
  ) => deterministicConfidence(parser, title, artist, hints, options)

  it('clamps to [0, 1]', () => {
    expect(clamp(1.4)).toBe(1)
    expect(clamp(-0.4)).toBe(0)
    expect(clamp(0.5)).toBe(0.5)
  })

  it('caps an LLM item below any deterministic one', () => {
    // PRD §7.9.5 precedence, enforced as a ceiling rather than a convention: an LLM item
    // can never outrank a deterministic one on identical evidence.
    expect(methodCeiling(ExtractionMethod.LLM_GROUNDED)).toBeLessThan(
      methodCeiling(ExtractionMethod.DETERMINISTIC),
    )
    // An ungrounded LLM item scores zero, which is the numeric form of "never shown".
    expect(methodCeiling(ExtractionMethod.LLM_UNGROUNDED)).toBe(0)
  })

  it('takes the base score from the parser', () => {
    expect(score('csv', 'Da Funk', 'Daft Punk')).toBeCloseTo(BASE_CONFIDENCE['csv']!)
  })

  it('falls back to the bare score for a parser it does not know', () => {
    expect(score('something-new', 'Da Funk', 'Daft Punk')).toBeCloseTo(BASE_CONFIDENCE['bare']!)
  })

  it('penalizes a pair it could not orient', () => {
    expect(
      score('dash', 'Da Funk', 'Daft Punk', EMPTY_HINTS, { ambiguousDirection: true }),
    ).toBeCloseTo(BASE_CONFIDENCE['dash']! + PENALTY_AMBIGUOUS_DIRECTION)
  })

  it('penalizes a missing artist', () => {
    // Matching has only a title to work with, which is a materially weaker search.
    expect(score('dash', 'Da Funk', null)).toBeCloseTo(BASE_CONFIDENCE['dash']! + PENALTY_NO_ARTIST)
  })

  it('penalizes a single-token title', () => {
    expect(score('dash', 'Home', 'Daft Punk')).toBeCloseTo(
      BASE_CONFIDENCE['dash']! + PENALTY_SHORT_TITLE,
    )
  })

  it('penalizes a title with no alphanumeric content at all', () => {
    expect(score('dash', '!!!', 'Daft Punk')).toBeCloseTo(
      BASE_CONFIDENCE['dash']! + PENALTY_SHORT_TITLE + PENALTY_DEGENERATE_TITLE,
    )
  })

  it.each(['1979', '99 Problems', '10%'])('does not call %j degenerate', title => {
    // Numeric and symbolic titles are real tracks. `/[a-z0-9]/i` here would also have
    // called every Cyrillic and Greek title degenerate, because `str.isalnum()` is
    // Unicode-aware and a naive character class is not.
    expect(score('dash', title, 'Someone')).toBeGreaterThan(
      BASE_CONFIDENCE['dash']! + PENALTY_DEGENERATE_TITLE,
    )
  })

  it.each(['Печаль', 'Μ’ αγαπούσες ποτέ', '夜に駆ける'])(
    'does not call the non-Latin title %j degenerate',
    title => {
      expect(score('dash', title, 'Someone')).toBeGreaterThan(
        BASE_CONFIDENCE['dash']! + PENALTY_DEGENERATE_TITLE,
      )
    },
  )

  it('rewards an ISRC, a duration and a structured position', () => {
    const hints = makeHints({ isrc: 'USRC17607839', durationS: 225, position: 3 })
    expect(score('dash', 'Da Funk', 'Daft Punk', hints, { structured: true })).toBeCloseTo(
      BASE_CONFIDENCE['dash']! + BONUS_ISRC + BONUS_DURATION + BONUS_STRUCTURED,
    )
  })

  it('sums adjustments the way Python does', () => {
    // CPython's `sum` has used Neumaier compensated summation on floats since 3.12, so
    // 0.55 + (-0.25 - 0.05 + 0.02) is exactly 0.27 there and 0.2700000000000001 with a
    // naive reduce here. Nothing downstream cares about the value; the byte comparison
    // in the differential does.
    const hints = makeHints({ durationS: 225 })
    expect(score('bare', 'Home', null, hints)).toBe(0.27)
  })

  it('never exceeds its method ceiling however many bonuses apply', () => {
    const hints = makeHints({ isrc: 'USRC17607839', durationS: 225 })
    expect(
      score('csv', 'One More Time', 'Daft Punk', hints, { structured: true }),
    ).toBeLessThanOrEqual(1)
  })

  it('sends a bare title to review by construction', () => {
    // A line with no separator is a title with no artist, and FR-007 exists for exactly
    // this case: it is parsed, and it is always reviewed.
    expect(score('bare', 'Bohemian Rhapsody', null)).toBeLessThan(REVIEW_THRESHOLD)
  })

  it('sends an uncorroborated headerless table to review too', () => {
    // Scored so the ambiguity penalty lands it under the threshold rather than
    // auto-accepting a coin flip about which column held the artist.
    expect(
      score('csv_headerless', 'Da Funk', 'Daft Punk', EMPTY_HINTS, { ambiguousDirection: true }),
    ).toBeLessThan(AUTO_ACCEPT_THRESHOLD)
  })
})

describe('the review queue', () => {
  it('holds exactly the items under the threshold', () => {
    const result = extractDeterministic(
      ['Bohemian Rhapsody', 'Under Pressure', "Don't Stop Me Now", 'Somebody to Love'].join('\n'),
    )
    expect(result.items.length).toBeGreaterThan(0)
    expect(below(result, REVIEW_THRESHOLD)).toHaveLength(result.items.length)
  })
})
