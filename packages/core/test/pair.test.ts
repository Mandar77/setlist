/**
 * The pair parsers' word lists, one entry at a time.
 *
 * `regressions.test.ts` proves the three defences against a credit line each work.
 * `parsers.test.ts` proves the five parsers parse. Neither touches the *tables* those
 * defences are made of — sixteen determiners, twenty-nine participles, a prefix
 * alternation — and a table is only as tested as its least-used row.
 *
 * Each case below is built so that exactly one defence can reject it. "Produced by Rick
 * Rubin" is caught three ways and therefore proves nothing about any of them; "Produced
 * in 1995 by Rick Rubin" is caught only by the credit prefix, because the word before
 * "by" is a year.
 */

import { describe, expect, it } from 'vitest'

import { makeLine, type Line } from '../src/models.js'
import { parseBy, parseDash, parseQuoted, parseTab } from '../src/parsers/pair.js'

const line = (text: string): Line => makeLine(text, 0)

// --------------------------------------------------------------------- determiners
/** A credit starting with one of these is a noun phrase, not an artist. */
const DETERMINERS = [
  'a',
  'an',
  'my',
  'our',
  'your',
  'their',
  'his',
  'her',
  'its',
  'this',
  'that',
  'these',
  'those',
  'some',
  'any',
  'every',
]

describe('a determiner on the artist side means it is not a name', () => {
  it.each(DETERMINERS)('rejects "by %s contributor"', determiner => {
    expect(parseBy(line(`Midnight City by ${determiner} contributor`))).toBeNull()
  })

  it('but "the" is deliberately absent, because bands begin with it', () => {
    // The Editors, The Smiths, The The. Adding "the" to that list would cost more real
    // artists than it saves credit lines.
    const match = parseBy(line('Munich by The Editors'))
    expect(match).not.toBeNull()
    expect(match!.artist).toBe('The Editors')
  })
})

// ---------------------------------------------------------------------- participles
/** The word immediately before "by" that turns a song line into a credit line. */
const CREDIT_PARTICIPLES = [
  'written',
  'produced',
  'mixed',
  'mastered',
  'composed',
  'arranged',
  'compiled',
  'curated',
  'edited',
  'published',
  'released',
  'uploaded',
  'posted',
  'submitted',
  'recorded',
  'directed',
  'assembled',
  'selected',
  'chosen',
  'picked',
  'ranked',
  'presented',
  'sourced',
  'sponsored',
  'inspired',
  'brought',
  'made',
  'created',
  'reviewed',
]

describe('a participle before "by" means a credit, not a song', () => {
  // The line starts with "Our" so no credit *prefix* matches, and "the editors" is not a
  // determiner phrase — so the participle is the only thing that can reject these.
  it.each(CREDIT_PARTICIPLES)('rejects "... %s by the editors"', participle => {
    expect(parseBy(line(`Our list, ${participle} by the editors`))).toBeNull()
  })

  it('ignores trailing punctuation on the participle', () => {
    expect(parseBy(line('Our list, compiled, by the editors'))).toBeNull()
  })

  it('but an ordinary word before "by" is fine', () => {
    // The control. Rejecting on any word before "by" would reject every real song line.
    const match = parseBy(line('Our favourite, Midnight City by M83'))
    expect(match).not.toBeNull()
    expect(match!.artist).toBe('M83')
  })
})

// --------------------------------------------------------------------- credit prefix
/**
 * A line that opens with one of these names no song, whatever follows.
 *
 * The participle-check cases above cannot reach these, because the word before "by" is a
 * year in every one. That separation is the point: without it, deleting the whole prefix
 * alternation would still pass, since most of these words are participles too.
 */
const CREDIT_PREFIXES = [
  'Written',
  'Produced',
  'Mixed',
  'Mastered',
  'Composed',
  'Arranged',
  'Compiled',
  'Curated',
  'Edited',
  'Published',
  'Released',
  'Uploaded',
  'Posted',
  'Submitted',
  'Recorded',
  'Directed',
  'Inspired',
]

describe('a line that opens with a credit word names no song', () => {
  it.each(CREDIT_PREFIXES)('rejects "%s in 1995 by Rick Rubin"', prefix => {
    expect(parseBy(line(`${prefix} in 1995 by Rick Rubin`))).toBeNull()
  })

  it.each(['Photo', 'Photos', 'Image', 'Images', 'Artwork'])(
    'rejects "%s by Vaughan Oliver"',
    prefix => {
      // These are not participles at all, so the prefix alternation is the only thing
      // standing between them and a fabricated song called "Artwork".
      expect(parseBy(line(`${prefix} by Vaughan Oliver`))).toBeNull()
    },
  )

  it('is case-insensitive', () => {
    expect(parseBy(line('ARTWORK by Vaughan Oliver'))).toBeNull()
  })

  it('only matches at the start of the line', () => {
    // Anchored, so a song whose title contains one of these words survives.
    const match = parseBy(line('The Artwork by Vaughan Oliver'))
    expect(match).not.toBeNull()
  })
})

// --------------------------------------------------------------------- length caps
describe('length caps separate a name from a clause', () => {
  it('accepts a six-word artist', () => {
    // "Nick Cave and the Bad Seeds" is six words, and so is "Crosby, Stills, Nash &
    // Young" once punctuation is counted as part of the names.
    const match = parseDash(line('Nick Cave and the Bad Seeds - Red Right Hand'))
    expect(match).not.toBeNull()
    expect(match!.artist).toBe('Nick Cave and the Bad Seeds')
  })

  it('rejects a seven-word artist', () => {
    expect(parseDash(line('one two three four five six seven - Red Right Hand'))).toBeNull()
  })

  it('rejects a long artist side on the by parser too', () => {
    expect(
      parseBy(line('This list was assembled by a very large group of people indeed')),
    ).toBeNull()
  })
})

// ----------------------------------------------------------------- quoted variants
describe('the quoted parser recognizes every quote pair', () => {
  it.each([
    ['straight double', '"Midnight City"'],
    ['curly double', '“Midnight City”'],
    ['angle double', '«Midnight City»'],
  ])('%s', (_label, quoted) => {
    const match = parseQuoted(line(`M83 - ${quoted}`))
    expect(match, `${quoted} was not recognized`).not.toBeNull()
    expect(match!.title).toBe('Midnight City')
  })

  it('reads the artist from either side', () => {
    expect(parseQuoted(line('"Midnight City" - M83'))!.artist).toBe('M83')
    expect(parseQuoted(line('M83 - "Midnight City"'))!.artist).toBe('M83')
    expect(parseQuoted(line('"Midnight City" by M83'))!.artist).toBe('M83')
  })

  it('does not recognize CJK corner brackets', () => {
    // Not supported, and deliberately recorded rather than assumed: the oracle's quote
    // sets are " “ « opening and " ” » closing, so a Japanese tracklist using
    // 「」 falls through to the other parsers. Widening it is a behaviour change and
    // belongs after CORE-07, not inside a port.
    expect(parseQuoted(line('M83 - 「Midnight City」'))).toBeNull()
  })

  it('declines a line with no quoted span at all', () => {
    expect(parseQuoted(line('M83 - Midnight City'))).toBeNull()
  })
})

// --------------------------------------------------------------------------- tabs
describe('the tab parser', () => {
  it('collapses a run of tabs into one boundary', () => {
    const match = parseTab(line(`Daft Punk${'\t'.repeat(3)}Da Funk`))
    expect([match!.artist, match!.title]).toEqual(['Daft Punk', 'Da Funk'])
  })

  it('declines a line with three columns', () => {
    // Three tab-separated fields is a table, and the table parser can read a header.
    expect(parseTab(line('Daft Punk\tDa Funk\tHomework'))).toBeNull()
  })

  it('declines a line with no tab', () => {
    expect(parseTab(line('Daft Punk - Da Funk'))).toBeNull()
  })
})
