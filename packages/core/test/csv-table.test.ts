/**
 * The whole-document table parser, row by row and alias by alias.
 *
 * `parsers.test.ts` covers the shapes a table comes in. This covers the parts that are
 * tables themselves: the csv quoting rules, the header synonym lists, the content
 * patterns that type a column, and the thresholds that decide whether a headerless table
 * can be oriented at all. Each of those is a row of data, and a row of data needs its
 * own case — 282 of this module's mutants survived a suite that tested the shapes and
 * not the rows.
 *
 * Expectations are literals. A test that reads `COLUMN_ALIASES` to assert things about
 * `COLUMN_ALIASES` is satisfied by an empty set.
 */

import { describe, expect, it } from 'vitest'

import { detectTable, parserName, parseTable, splitRow } from '../src/parsers/csv-table.js'
import { splitLines } from '../src/parsers/index.js'

const TAB = String.fromCodePoint(9)

// -------------------------------------------------------------------- the csv reader
describe('splitRow follows csv quoting rules', () => {
  it('splits on the delimiter', () => {
    expect(splitRow('Daft Punk,Da Funk', ',')).toEqual(['Daft Punk', 'Da Funk'])
  })

  it('keeps a delimiter inside a quoted field', () => {
    // The reason this is a reader and not a `String.split`. "Crosby, Stills & Nash" is
    // one artist, and splitting it makes two.
    expect(splitRow('"Crosby, Stills & Nash",Guinnevere', ',')).toEqual([
      'Crosby, Stills & Nash',
      'Guinnevere',
    ])
  })

  it('reads a doubled quote inside a quoted field as one quote', () => {
    expect(splitRow('"Say ""Yes""",Artist', ',')).toEqual(['Say "Yes"', 'Artist'])
  })

  it('leaves a quote in the middle of an unquoted field alone', () => {
    // Python's csv reader with `skipinitialspace=True` treats a field as quoted only
    // when the quote is its first character. Getting this wrong turns the line into a
    // parse error in one language and a title in the other.
    expect(splitRow('Artist,Say "Yes"', ',')).toEqual(['Artist', 'Say "Yes"'])
  })

  it('skips spaces before a quoted field, and strips the cell on the way out', () => {
    // Two separate rules that look like one. `skipinitialspace` consumes the spaces
    // before the quote; the strip at the end of the loop takes the ones inside it. A
    // quoted field is therefore not a way to keep padding — matching the oracle, which
    // strips every cell for the same reason pydantic strips every string.
    expect(splitRow('Artist,  "  Da Funk  "', ',')).toEqual(['Artist', 'Da Funk'])
  })

  it('keeps an empty trailing field', () => {
    // A row ending in a delimiter has a last column, and it is empty. Dropping it
    // shortens the row and breaks the width check that recognizes the table.
    expect(splitRow('Artist,Title,', ',')).toEqual(['Artist', 'Title', ''])
  })

  it('keeps an empty leading field', () => {
    expect(splitRow(',Title', ',')).toEqual(['', 'Title'])
  })

  it('keeps an empty field in the middle', () => {
    expect(splitRow('Artist,,Title', ',')).toEqual(['Artist', '', 'Title'])
  })

  it('returns nothing for an empty line', () => {
    // Not `['']`. An empty line is zero fields, and one empty field would make every
    // blank line a one-column row that breaks the width check.
    expect(splitRow('', ',')).toEqual([])
  })

  it('reads a single field with no delimiter', () => {
    expect(splitRow('Bohemian Rhapsody', ',')).toEqual(['Bohemian Rhapsody'])
  })

  it.each([
    ['a comma', ','],
    ['a tab', TAB],
    ['a semicolon', ';'],
    ['a pipe', '|'],
  ])('splits on %s', (_label, delimiter) => {
    expect(splitRow(`Daft Punk${delimiter}Da Funk`, delimiter)).toEqual(['Daft Punk', 'Da Funk'])
  })

  it('ignores a delimiter it was not given', () => {
    expect(splitRow('Daft Punk;Da Funk', ',')).toEqual(['Daft Punk;Da Funk'])
  })
})

// ----------------------------------------------------------------- the header labels
const header = (
  label: string,
  field: 'title' | 'artist' | 'album' | 'isrc' | 'duration' | 'year',
) => {
  const rows =
    field === 'title'
      ? `${label},Artist\nDa Funk,Daft Punk\nGenesis,Justice`
      : `Title,${label}\nDa Funk,Daft Punk\nGenesis,Justice`
  const spec = detectTable(splitLines(rows))
  expect(spec, `"${label}" was not recognized as a ${field} header`).not.toBeNull()
  return spec!
}

describe('header labels are recognized by synonym', () => {
  // Spelled out in the module's own order so deleting one fails exactly one case and
  // names it. "titel" and "artiste" are there because exported playlists are not all in
  // English.
  it.each([
    'title',
    'track',
    'song',
    'name',
    'track name',
    'song title',
    'track title',
    'song name',
    'titel',
  ])('%j names the title column', label => {
    expect(header(label, 'title').columns['title']).toBe(0)
  })

  it.each([
    'artist',
    'artists',
    'performer',
    'band',
    'artist name',
    'album artist',
    'artiste',
    'by',
  ])('%j names the artist column', label => {
    expect(header(label, 'artist').columns['artist']).toBe(1)
  })

  it.each(['album', 'release', 'album name'])('%j names the album column', label => {
    const spec = detectTable(splitLines(`Title,Artist,${label}\nDa Funk,Daft Punk,Homework`))
    expect(spec?.columns['album']).toBe(2)
  })

  it.each(['isrc', 'isrc code'])('%j names the isrc column', label => {
    const spec = detectTable(splitLines(`Title,Artist,${label}\nDa Funk,Daft Punk,USRC17607839`))
    expect(spec?.columns['isrc']).toBe(2)
  })

  it.each(['duration', 'length', 'time', 'runtime', 'duration ms', 'duration s', 'track duration'])(
    '%j names the duration column',
    label => {
      const spec = detectTable(splitLines(`Title,Artist,${label}\nDa Funk,Daft Punk,5:28`))
      expect(spec?.columns['duration']).toBe(2)
    },
  )

  it.each(['year', 'released', 'release year', 'release date', 'date'])(
    '%j names the year column',
    label => {
      const spec = detectTable(splitLines(`Title,Artist,${label}\nDa Funk,Daft Punk,1995`))
      expect(spec?.columns['year']).toBe(2)
    },
  )

  it('matches labels case- and space-insensitively', () => {
    expect(header('  TRACK NAME  ', 'title').columns['title']).toBe(0)
  })

  it('does not accept a label it has never heard of', () => {
    // The control. A matcher that accepted anything would make the first data row the
    // header and silently drop a track.
    const spec = detectTable(splitLines('Wombat,Platypus\nDa Funk,Daft Punk\nGenesis,Justice'))
    expect(spec?.headerRow).toBeNull()
  })
})

// --------------------------------------------------------------- typing by content
describe('columns are typed by what is in them', () => {
  const table = (extra: string[]) =>
    detectTable(
      splitLines(
        [
          `Daft Punk,Da Funk,${extra[0]}`,
          `Daft Punk,Around the World,${extra[1]}`,
          `Justice,Genesis,${extra[2]}`,
          `Justice,Phantom,${extra[3]}`,
          `Justice,Stress,${extra[4]}`,
        ].join('\n'),
      ),
    )

  it('finds an ISRC column with no header', () => {
    const spec = table([
      'USRC17607839',
      'GBAYE0000456',
      'FRUM71200001',
      'FRUM71200002',
      'FRUM71200003',
    ])
    expect(spec?.columns['isrc']).toBe(2)
  })

  it('accepts an ISRC written with separators after the registrant', () => {
    // The separators go after the five-character prefix, not inside it: "USRC1-76-07839"
    // is the punctuated form of "USRC17607839". "US-RC1-76-07839" is not an ISRC and is
    // deliberately not matched.
    const spec = table([
      'USRC1-76-07839',
      'GBAYE-00-00456',
      'FRUM7-12-00001',
      'FRUM7-12-00002',
      'FRUM7-12-00003',
    ])
    expect(spec?.columns['isrc']).toBe(2)
  })

  it('finds a clock column', () => {
    const spec = table(['5:28', '7:09', '3:54', '3:12', '4:57'])
    expect(spec?.columns['duration']).toBe(2)
  })

  it('accepts an hour-long clock', () => {
    const spec = table(['1:05:28', '1:07:09', '1:03:54', '1:03:12', '1:04:57'])
    expect(spec?.columns['duration']).toBe(2)
  })

  it('finds a year column', () => {
    const spec = table(['1995', '1997', '2007', '2007', '2007'])
    expect(spec?.columns['year']).toBe(2)
  })

  it.each([
    ['an 1800s year', '1850'],
    ['a 1900s year', '1979'],
    ['a 2000s year', '2016'],
    ['a 2100s year', '2101'],
  ])('reads %s', (_label, year) => {
    const spec = table([year, year, year, year, year])
    expect(spec?.columns['year']).toBe(2)
  })

  it('does not call a column of track numbers a year', () => {
    // The control: four-digit-ish numbers are not automatically years, and typing the
    // position column as a year would attach a nonsense release date to every row.
    const spec = table(['1', '2', '3', '4', '5'])
    expect(spec?.columns['year']).toBeUndefined()
  })

  it('needs most of a column to match before typing it', () => {
    // One ISRC among five cells is a coincidence, not a column.
    const spec = table(['USRC17607839', 'nope', 'nope', 'nope', 'nope'])
    expect(spec?.columns['isrc']).toBeUndefined()
  })
})

// ------------------------------------------------------------- reading the data rows
describe('data rows become matches', () => {
  it('reads a duration given as a clock', () => {
    const lines = splitLines('Artist,Title,Duration\nDaft Punk,Da Funk,5:28')
    expect(parseTable(lines, detectTable(lines)!)[0]!.hints.durationS).toBe(328)
  })

  it('reads a duration given in whole seconds', () => {
    const lines = splitLines('Artist,Title,Duration\nDaft Punk,Da Funk,328')
    expect(parseTable(lines, detectTable(lines)!)[0]!.hints.durationS).toBe(328)
  })

  it('reads a duration given in milliseconds', () => {
    // The threshold is 1000: anything at or above it is milliseconds, because no track
    // is a thousand seconds and plenty are a thousand milliseconds long.
    const lines = splitLines('Artist,Title,Duration\nDaft Punk,Da Funk,328000')
    expect(parseTable(lines, detectTable(lines)!)[0]!.hints.durationS).toBe(328)
  })

  it('ignores a duration cell that is not a number at all', () => {
    const lines = splitLines('Artist,Title,Duration\nDaft Punk,Da Funk,unknown')
    expect(parseTable(lines, detectTable(lines)!)[0]!.hints.durationS).toBeNull()
  })

  it('ignores an empty duration cell rather than reading it as zero', () => {
    // `Number('')` is 0 in JavaScript and a ValueError in Python. A zero-second track
    // would make the matcher reject every real recording of it.
    const lines = splitLines('Artist,Title,Duration\nDaft Punk,Da Funk,')
    expect(parseTable(lines, detectTable(lines)!)[0]!.hints.durationS).toBeNull()
  })

  it('pulls a year out of a full release date', () => {
    const lines = splitLines('Artist,Title,Release Date\nDaft Punk,Da Funk,1995-03-01')
    expect(parseTable(lines, detectTable(lines)!)[0]!.hints.year).toBe(1995)
  })

  it('normalizes an ISRC and refuses a malformed one', () => {
    const good = splitLines('Artist,Title,ISRC\nDaft Punk,Da Funk,us-rc1-76-07839')
    expect(parseTable(good, detectTable(good)!)[0]!.hints.isrc).toBe('USRC17607839')

    const bad = splitLines('Artist,Title,ISRC\nDaft Punk,Da Funk,NOT-AN-ISRC')
    expect(parseTable(bad, detectTable(bad)!)[0]!.hints.isrc).toBeNull()
  })

  it('skips a row with no title', () => {
    const lines = splitLines('Artist,Title\nDaft Punk,\nJustice,Genesis')
    expect(parseTable(lines, detectTable(lines)!).map(m => m.title)).toEqual(['Genesis'])
  })

  it('skips the header and nothing else', () => {
    const lines = splitLines('Artist,Title\nDaft Punk,Da Funk\nJustice,Genesis\nM83,Midnight City')
    expect(parseTable(lines, detectTable(lines)!)).toHaveLength(3)
  })
})

// ------------------------------------------------------------- direction inference
describe('a headerless table is oriented by repetition', () => {
  const sixRows = (first: string[], second: string[]) =>
    detectTable(splitLines(first.map((a, i) => `${a},${second[i]}`).join('\n')))

  const ARTISTS = ['Daft Punk', 'Daft Punk', 'Daft Punk', 'Justice', 'Justice', 'Justice']
  const TITLES = ['Da Funk', 'Around the World', 'Revolution 909', 'Genesis', 'Phantom', 'Stress']

  it('reads the repeating column as the artist', () => {
    const spec = sixRows(ARTISTS, TITLES)
    expect(spec?.ambiguous).toBe(false)
    expect(spec?.columns['artist']).toBe(0)
  })

  it('reads it on the right just as readily', () => {
    const spec = sixRows(TITLES, ARTISTS)
    expect(spec?.columns['artist']).toBe(1)
    expect(spec?.columns['title']).toBe(0)
  })

  it('stays ambiguous with too few rows to judge', () => {
    const spec = detectTable(splitLines('Daft Punk,Da Funk\nJustice,Genesis\nM83,Midnight City'))
    expect(spec?.ambiguous).toBe(true)
  })

  it('stays ambiguous when neither column repeats more than the other', () => {
    // Six distinct artists and six distinct titles: there is no signal, and inventing
    // one would be a coin flip presented as a fact.
    const spec = sixRows(
      ['Daft Punk', 'Justice', 'M83', 'Air', 'Phoenix', 'Cassius'],
      ['Da Funk', 'Genesis', 'Midnight City', 'La Femme', '1901', 'Feeling For You'],
    )
    expect(spec?.ambiguous).toBe(true)
  })

  it('scores an ambiguous table into its own confidence bucket', () => {
    const spec = detectTable(splitLines('Daft Punk,Da Funk\nJustice,Genesis\nM83,Midnight City'))
    expect(parserName(spec!)).toBe('csv_headerless')
    expect(parserName(sixRows(ARTISTS, TITLES)!)).toBe('csv')
  })
})

// ------------------------------------------------------------------- not a table
describe('detectTable declines what is not a table', () => {
  it.each([
    ['a dash list', 'Daft Punk - Da Funk\nJustice - Genesis'],
    ['rows of inconsistent width', 'a,b\nc,d,e\nf'],
    ['a single row', 'a,b'],
    ['a bare title list', 'Da Funk\nGenesis\nMidnight City'],
    ['prose', 'I went to see them in Berlin.\nIt was incredible.\nTruly.'],
  ])('%s', (_label, text) => {
    expect(detectTable(splitLines(text))).toBeNull()
  })

  it('declines a table wider than the column cap', () => {
    const wide = Array.from({ length: 30 }, (_, i) => `c${i}`).join(',')
    expect(detectTable(splitLines(`${wide}\n${wide}\n${wide}`))).toBeNull()
  })
})
