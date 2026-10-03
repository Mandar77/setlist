/**
 * The deterministic grammar: affixes, the five line parsers, line triage and tables.
 *
 * Ported from `tools/oracle-py/tests/test_parsers.py` (ADR-001). The differential suites
 * prove the port says the same thing as the oracle; this says what the thing is. At
 * CORE-07 the oracle retires and this becomes the only written record of it.
 *
 * The regressions ADR-001 names by name live in `regressions.test.ts` instead, with the
 * bug that produced each one.
 */

import { describe, expect, it } from 'vitest'

import { makeLine, type Line } from '../src/models.js'
import { stripPrefixes, stripSuffixes } from '../src/parsers/affixes.js'
import { detectTable, parseTable, type TableSpec } from '../src/parsers/csv-table.js'
import { parserName } from '../src/parsers/csv-table.js'
import {
  isListShaped,
  looksLikeNoise,
  looksLikeProse,
  parseLine,
  splitLines,
} from '../src/parsers/index.js'
import { parseBare, parseDash, parseQuoted, parseTab } from '../src/parsers/pair.js'

const line = (text: string, offset = 0): Line => makeLine(text, offset)

// ------------------------------------------------------------------------ splitting
describe('splitting a document into lines', () => {
  it('gives exact offsets', () => {
    // Everything downstream that builds a span depends on this arithmetic, and an
    // off-by-one here is invisible until a title is sliced one character short.
    const lines = splitLines('abc\nde\n\nf')
    expect(lines.map(l => [l.text, l.offset])).toEqual([
      ['abc', 0],
      ['de', 4],
      ['', 7],
      ['f', 8],
    ])
  })

  it('reconstructs the document it came from', () => {
    const text = 'Daft Punk - Da Funk\n\nJustice - Genesis'
    expect(
      splitLines(text)
        .map(l => l.text)
        .join('\n'),
    ).toBe(text)
  })
})

// -------------------------------------------------------------------------- affixes
describe('leading markers', () => {
  it.each([
    ['1. Daft Punk - Da Funk', 'Daft Punk - Da Funk', 1],
    ['12) Daft Punk - Da Funk', 'Daft Punk - Da Funk', 12],
    ['#3 - Daft Punk - Da Funk', 'Daft Punk - Da Funk', 3],
    ['[4] Daft Punk - Da Funk', 'Daft Punk - Da Funk', 4],
    ['(7) Daft Punk - Da Funk', 'Daft Punk - Da Funk', 7],
  ])('read an ordinal out of %j', (raw, remainder, position) => {
    const { line: stripped, hints } = stripPrefixes(line(raw))
    expect(stripped.text).toBe(remainder)
    expect(hints.position).toBe(position)
  })

  it.each(['- ', '* ', '• ', '· ', '+ '])('consume the bullet %j', bullet => {
    expect(stripPrefixes(line(`${bullet}Justice - Genesis`)).line.text).toBe('Justice - Genesis')
  })

  it.each([
    ['00:14 Artist - Title', 14],
    ['[1:02:17] Artist - Title', 3737],
    ['(4:21) Artist - Title', 261],
  ])('read a timestamp out of %j', (raw, seconds) => {
    const { line: stripped, hints } = stripPrefixes(line(raw))
    expect(stripped.text).toBe('Artist - Title')
    expect(hints.timestampS).toBe(seconds)
  })

  it('chain, in any order', () => {
    const { line: stripped, hints } = stripPrefixes(line('3. [00:14] Artist - Title'))
    expect(stripped.text).toBe('Artist - Title')
    expect(hints.position).toBe(3)
    expect(hints.timestampS).toBe(14)
  })

  it('advance the offset by exactly what they consumed', () => {
    // The span has to keep pointing at the right characters after the marker is eaten.
    expect(stripPrefixes(line('1. Artist - Title', 100)).line.offset).toBe(103)
  })

  it('leave an unmarked line alone', () => {
    const { line: stripped, hints } = stripPrefixes(line('Daft Punk - Da Funk'))
    expect(stripped.text).toBe('Daft Punk - Da Funk')
    expect(hints.position).toBeNull()
    expect(hints.timestampS).toBeNull()
  })
})

describe('trailing annotations', () => {
  it('peel a bracketed run time', () => {
    const { line: stripped, hints } = stripSuffixes(line('Artist - Title (3:45)'))
    expect(stripped.text).toBe('Artist - Title')
    expect(hints.durationS).toBe(225)
  })

  it('leave a bare trailing clock alone', () => {
    // Unbracketed, a trailing clock is indistinguishable from a title like "9:30" — and
    // "9:30" is a real Weather Report track.
    const { line: stripped, hints } = stripSuffixes(line('Artist - 9:30'))
    expect(stripped.text).toBe('Artist - 9:30')
    expect(hints.durationS).toBeNull()
  })

  it('peel a trailing ISRC', () => {
    const { line: stripped, hints } = stripSuffixes(line('Artist - Title [USRC17607839]'))
    expect(stripped.text).toBe('Artist - Title')
    expect(hints.isrc).toBe('USRC17607839')
  })

  it('peel both at once', () => {
    const { hints } = stripSuffixes(line('Artist - Title (3:45) [USRC17607839]'))
    expect(hints.durationS).toBe(225)
    expect(hints.isrc).toBe('USRC17607839')
  })
})

// -------------------------------------------------------------------- pair parsers
describe('the dash parser', () => {
  it.each([' - ', ' – ', '–', ' — ', ' ~ ', ' | ', ' / '])('splits on %j', separator => {
    const match = parseDash(line(`Daft Punk${separator}Da Funk`))
    expect(match).not.toBeNull()
    expect([match!.artist, match!.title]).toEqual(['Daft Punk', 'Da Funk'])
  })

  it('defaults to artist first', () => {
    // ADR-002 replaces this default with an inferred orientation at CORE-05. Until then
    // it is the convention FR-002 names, and it is a default, not a certainty.
    const match = parseDash(line('Oasis - Wonderwall'))
    expect([match!.artist, match!.title]).toEqual(['Oasis', 'Wonderwall'])
  })

  it('takes a version annotation as evidence of which side is the title', () => {
    const match = parseDash(line('Da Funk (Live) - Daft Punk'))
    expect([match!.artist, match!.title]).toEqual(['Daft Punk', 'Da Funk'])
  })

  it('flags a pair it cannot orient', () => {
    // Both sides carry a version annotation, so the cue that normally identifies the
    // title side points at both. Ambiguous means "send it to review", not "guess".
    expect(parseDash(line('Song (Live) - Other (Remix)'))!.ambiguousDirection).toBe(true)
  })

  it('does not split a hyphenated name that has no spaces', () => {
    // "Jean-Michel Jarre" is one name. Splitting on a bare hyphen would halve a lot of
    // artists.
    expect(parseDash(line('Jean-Michel Jarre'))).toBeNull()
  })

  it('splits only at the first separator, and keeps the rest', () => {
    // `re.split(..., maxsplit=1)` has no JavaScript equivalent, and `String.split` with
    // a limit silently DROPS the remainder instead of keeping it. The tell is the
    // qualifier: " - Live" has to reach `stripQualifiers` to become one, so a port that
    // lost the tail would produce the same title and quietly no qualifier at all.
    const match = parseDash(line('Justice - Genesis - Live'))
    expect([match!.artist, match!.title]).toEqual(['Justice', 'Genesis'])
    expect([...match!.hints.qualifiers]).toEqual(['live'])
  })

  it('rejects a left side too long to be a name', () => {
    expect(
      parseDash(line('This was easily the best thing all weekend - and I mean that')),
    ).toBeNull()
  })
})

describe('the quoted parser', () => {
  it.each([
    'M83 - "Midnight City"',
    '"Midnight City" - M83',
    '"Midnight City" by M83',
    'M83 – “Midnight City”',
  ])('reads %j', raw => {
    const match = parseQuoted(line(raw))
    expect(match).not.toBeNull()
    expect([match!.artist, match!.title]).toEqual(['M83', 'Midnight City'])
  })

  it('does not treat apostrophes as delimiters', () => {
    // "Guns N' Roses - Sweet Child o' Mine" has two apostrophes and no quoted title.
    expect(parseQuoted(line("Guns N' Roses - Sweet Child o' Mine"))).toBeNull()
  })
})

describe('the tab parser', () => {
  it('is always ambiguous about direction', () => {
    // A stray tab carries no convention about column order the way a dash does. Whole
    // documents of TSV go through the table parser, which can read a header.
    const match = parseTab(line('Daft Punk\tDa Funk'))
    expect([match!.artist, match!.title]).toEqual(['Daft Punk', 'Da Funk'])
    expect(match!.ambiguousDirection).toBe(true)
  })
})

describe('the bare parser', () => {
  it('claims a short separator-less line', () => {
    const match = parseBare(line('Bohemian Rhapsody'))
    expect(match!.title).toBe('Bohemian Rhapsody')
    expect(match!.artist).toBeNull()
  })

  it('rejects prose', () => {
    expect(parseBare(line('This was the best set of the entire weekend. Truly.'))).toBeNull()
  })
})

describe('the parser registry', () => {
  it('combines affixes with the winning pattern', () => {
    const match = parseLine(line('3. Daft Punk - Da Funk (3:45) [USRC17607839]'))
    expect([match!.artist, match!.title]).toEqual(['Daft Punk', 'Da Funk'])
    expect(match!.hints.position).toBe(3)
    expect(match!.hints.durationS).toBe(225)
    expect(match!.hints.isrc).toBe('USRC17607839')
    expect(match!.structured).toBe(true)
  })

  it('does not parse noise', () => {
    expect(parseLine(line('### Tracklist'))).toBeNull()
  })

  it('requires opting in before a bare title is claimed', () => {
    // The gate that stops an article's sentence fragments becoming songs.
    expect(parseLine(line('Bohemian Rhapsody'))).toBeNull()
    expect(parseLine(line('Bohemian Rhapsody'), true)).not.toBeNull()
  })

  it('prefers a quoted title over the dash reading of the same line', () => {
    // Registry order is by how explicitly each pattern labels its own structure, and
    // this is the case where it matters: both parsers match, and only one is right.
    const match = parseLine(line('"Midnight City" - M83'))
    expect(match!.parser).toBe('quoted')
    expect([match!.artist, match!.title]).toEqual(['M83', 'Midnight City'])
  })
})

// --------------------------------------------------------------------- line triage
describe('noise', () => {
  it.each([
    '---',
    '===',
    '### Tracklist',
    '```',
    '| --- | --- |',
    'https://example.com/x',
    '<div>',
    'Encore:',
    '   ',
    '!!!',
  ])('drops %j', raw => {
    expect(looksLikeNoise(raw)).toBe(true)
  })

  it.each([
    'Daft Punk - Da Funk',
    'Bohemian Rhapsody',
    '1. Justice - Genesis',
    '10%',
    'Μ’ αγαπούσες',
  ])('keeps %j', raw => {
    expect(looksLikeNoise(raw)).toBe(false)
  })
})

describe('prose', () => {
  it.each([
    'This was the best set of the entire weekend. Truly.',
    'I went to see them in Berlin last year and it was completely incredible honestly',
  ])('recognizes %j', raw => {
    expect(looksLikeProse(raw)).toBe(true)
  })

  it.each([
    'Mr. Brightside',
    'Vol. 2',
    'R.E.M. - Losing My Religion',
    'Daft Punk feat. Pharrell - Get Lucky',
  ])('does not mistake %j for a sentence', raw => {
    // Abbreviations and single-letter initials carry periods that are part of names, and
    // names routinely appear in titles.
    expect(looksLikeProse(raw)).toBe(false)
  })

  it('is not noise', () => {
    // Prose may well mention songs, so it goes to the LLM residual pass rather than
    // being dropped. Conflating the two is the classic way to lose recall.
    const text = 'This was the best set of the entire weekend. Truly.'
    expect(looksLikeProse(text)).toBe(true)
    expect(looksLikeNoise(text)).toBe(false)
  })
})

describe('list shape', () => {
  it('recognizes a list', () => {
    expect(isListShaped(splitLines('Da Funk\nGenesis\nMidnight City\nWonderwall'))).toBe(true)
  })

  it('refuses a document too short to judge', () => {
    expect(isListShaped(splitLines('Da Funk\nGenesis'))).toBe(false)
  })

  it('refuses an article', () => {
    const article = [
      'I spent the weekend at a festival and it was completely incredible from start to finish.',
      'The headliner played for two hours and the crowd never once sat down the entire time.',
      'Honestly I have not had a weekend like that in years and I would go again tomorrow.',
      'Da Funk',
    ].join('\n')
    expect(isListShaped(splitLines(article))).toBe(false)
  })
})

// -------------------------------------------------------------------------- tables
const spec = (text: string): { lines: Line[]; spec: TableSpec } => {
  const lines = splitLines(text)
  const detected = detectTable(lines)
  expect(detected, `expected a table in:\n${text}`).not.toBeNull()
  return { lines, spec: detected! }
}

describe('tables with a header', () => {
  it('read the column roles out of it', () => {
    const { spec: s } = spec('Artist,Title,Album\nDaft Punk,Da Funk,Homework')
    expect(s.headerRow).toBe(0)
    expect(s.columns).toMatchObject({ artist: 0, title: 1, album: 2 })
  })

  it('skip the header row', () => {
    const { lines, spec: s } = spec('Artist,Title\nDaft Punk,Da Funk\nJustice,Genesis')
    expect(parseTable(lines, s).map(m => [m.artist, m.title])).toEqual([
      ['Daft Punk', 'Da Funk'],
      ['Justice', 'Genesis'],
    ])
  })

  it('believe the header about column order', () => {
    const { lines, spec: s } = spec('Title,Artist\nDa Funk,Daft Punk')
    const match = parseTable(lines, s)[0]!
    expect([match.artist, match.title]).toEqual(['Daft Punk', 'Da Funk'])
    // A header is an explicit cue, so there is nothing ambiguous to review.
    expect(match.ambiguousDirection).toBe(false)
  })

  it('read a markdown table', () => {
    const { lines, spec: s } = spec(
      '| Artist | Title |\n|---|---|\n| Daft Punk | Da Funk |\n| Justice | Genesis |',
    )
    expect(parseTable(lines, s).map(m => [m.artist, m.title])).toEqual([
      ['Daft Punk', 'Da Funk'],
      ['Justice', 'Genesis'],
    ])
  })

  it('read a duration given in milliseconds', () => {
    const { lines, spec: s } = spec('Artist,Title,Duration\nDaft Punk,Da Funk,328000')
    expect(parseTable(lines, s)[0]!.hints.durationS).toBe(328)
  })
})

describe('headerless tables', () => {
  it('infer direction from the column that repeats', () => {
    // ADR-002 step 2: a real tracklist is internally consistent, and the artist column
    // repeats while the title column does not.
    const { spec: s } = spec(
      [
        'Daft Punk,Da Funk',
        'Daft Punk,Around the World',
        'Daft Punk,Revolution 909',
        'Justice,Genesis',
        'Justice,Phantom',
        'Justice,Stress',
      ].join('\n'),
    )
    expect(s.headerRow).toBeNull()
    expect(s.ambiguous).toBe(false)
    expect(s.columns['artist']).toBe(0)
  })

  it('infer the reversed direction just as readily', () => {
    // The must-fail direction for the test above: an inference that always answers
    // "column 0 is the artist" would pass it and be worthless.
    const { spec: s } = spec(
      [
        'Da Funk,Daft Punk',
        'Around the World,Daft Punk',
        'Revolution 909,Daft Punk',
        'Genesis,Justice',
        'Phantom,Justice',
        'Stress,Justice',
      ].join('\n'),
    )
    expect(s.columns['artist']).toBe(1)
    expect(s.columns['title']).toBe(0)
  })

  it('stay ambiguous when there is not enough repetition to judge', () => {
    const { spec: s } = spec('Daft Punk,Da Funk\nJustice,Genesis\nM83,Midnight City')
    expect(s.ambiguous).toBe(true)
    // Scored in its own confidence bucket so a coin flip about which column held the
    // artist lands in review rather than auto-accepting.
    expect(parserName(s)).toBe('csv_headerless')
  })

  it('type ISRC and duration columns from their content', () => {
    const { lines, spec: s } = spec(
      [
        'Daft Punk,Da Funk,USRC17607839,5:28',
        'Daft Punk,Around the World,GBAYE0000456,7:09',
        'Justice,Genesis,FRUM71200001,3:54',
        'Justice,Phantom,FRUM71200002,3:12',
        'Justice,Stress,FRUM71200003,4:57',
      ].join('\n'),
    )
    expect(s.columns['isrc']).toBe(2)
    expect(s.columns['duration']).toBe(3)
    const first = parseTable(lines, s)[0]!
    expect(first.hints.isrc).toBe('USRC17607839')
    expect(first.hints.durationS).toBe(328)
  })
})

describe('things that are not tables', () => {
  it.each([
    ['a plain dash list', 'Daft Punk - Da Funk\nJustice - Genesis'],
    ['rows of inconsistent width', 'a,b\nc,d,e\nf'],
    ['a document too short to be one', 'a,b'],
  ])('%s', (_label, text) => {
    expect(detectTable(splitLines(text))).toBeNull()
  })
})
