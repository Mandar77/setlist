/**
 * Normalization and the qualifier tables, one pattern at a time.
 *
 * `differential.test.ts` runs every one of these functions over 4,903 corpus strings and
 * compares the answers to the oracle's. That proves the port agrees; it does not prove
 * any particular rule is exercised, because a corpus of real song titles reaches the
 * common patterns constantly and the rare ones never. Ten qualifier patterns, eight
 * bare-version words, eight non-remix mixes: each is a row, and a row needs a case.
 *
 * Ported from `tools/oracle-py/tests/test_normalize.py` (ADR-001).
 */

import { describe, expect, it } from 'vitest'

import { Qualifier } from '../src/enums.js'
import {
  dedupeKey,
  fold,
  hasVersionAnnotation,
  normalizeArtist,
  normalizeDocument,
  normalizeIsrc,
  parseDuration,
  pyStrip,
  splitArtistCredits,
  splitFeatured,
  stripQualifiers,
  tokens,
} from '../src/normalize.js'

const cp = (...points: number[]) => String.fromCodePoint(...points)

// ------------------------------------------------------------------- normalizeDocument
describe('normalizeDocument', () => {
  it('converts every line ending to a newline', () => {
    expect(normalizeDocument(`a${cp(13, 10)}b${cp(13)}c${cp(10)}d`)).toBe('a\nb\nc\nd')
  })

  it('applies NFKC', () => {
    // Fullwidth and compatibility forms are the same characters to a reader and
    // different ones to a comparison. The matcher would miss every one of them.
    expect(normalizeDocument(cp(0xff21, 0xff22))).toBe('AB')
    expect(normalizeDocument(cp(0x2460))).toBe('1')
  })

  it.each([
    ['a soft hyphen', 0x00ad],
    ['a zero-width space', 0x200b],
    ['a zero-width non-joiner', 0x200c],
    ['a zero-width joiner', 0x200d],
    ['a left-to-right mark', 0x200e],
    ['a right-to-left mark', 0x200f],
    ['a word joiner', 0x2060],
    ['a byte-order mark', 0xfeff],
  ])('strips %s', (_label, point) => {
    // These are invisible, so a title containing one looks identical to one that does
    // not and hashes differently. Every span offset downstream moves too.
    expect(normalizeDocument(`Da${cp(point)}Funk`)).toBe('DaFunk')
  })

  it('keeps tabs and newlines but drops other control characters', () => {
    // A tab is a column boundary the table parser needs; a NUL and a BEL are noise, and
    // they are removed rather than replaced — nothing appears where they were.
    expect(normalizeDocument(`a${cp(9)}b${cp(10)}c${cp(0)}d${cp(7)}e`)).toBe(
      `a${cp(9)}b${cp(10)}cde`,
    )
  })

  it('is idempotent', () => {
    const once = normalizeDocument(`Daft${cp(0x200b)}Punk${cp(13, 10)}${cp(0xff0d)} Da Funk`)
    expect(normalizeDocument(once)).toBe(once)
  })

  it('leaves visible content alone', () => {
    const text = 'Μ’ αγαπούσες ποτέ — Άννα Βίσση'
    expect(normalizeDocument(text)).toBe(text)
  })
})

// --------------------------------------------------------------------------- pyStrip
describe('pyStrip matches Python str.strip, not JavaScript trim', () => {
  it.each([
    ['a file separator', 0x001c],
    ['a group separator', 0x001d],
    ['a record separator', 0x001e],
    ['a unit separator', 0x001f],
    ['a next line', 0x0085],
  ])('strips %s, which JavaScript trim does not', (_label, point) => {
    expect(pyStrip(`${cp(point)}Da Funk${cp(point)}`)).toBe('Da Funk')
  })

  it('leaves the inside alone', () => {
    expect(pyStrip('  Da  Funk  ')).toBe('Da  Funk')
  })
})

// ------------------------------------------------------------------------------ fold
describe('fold', () => {
  it('transliterates and lowercases', () => {
    expect(fold('Björk')).toBe('bjork')
    expect(fold('Печаль')).toBe('pechal')
  })

  it('drops punctuation and collapses whitespace', () => {
    expect(fold('  Da   Funk!!  ')).toBe('da funk')
  })

  it('keeps digits', () => {
    // "1979" and "99 Problems" are titles, and a fold that dropped digits would collapse
    // them to the empty string and make every numeric title the same song.
    expect(fold('99 Problems')).toBe('99 problems')
  })

  it('is empty for an empty input', () => {
    expect(fold('   ')).toBe('')
  })

  it('splits into tokens', () => {
    expect(tokens('Daft Punk - Da Funk!')).toEqual(['daft', 'punk', 'da', 'funk'])
  })
})

// ----------------------------------------------------------------------- qualifiers
describe('qualifier annotations are recognized by name', () => {
  const peel = (title: string) => stripQualifiers(title)

  it.each([
    ['(Live)', Qualifier.LIVE],
    ['(Live at Wembley)', Qualifier.LIVE],
    ['(Remaster)', Qualifier.REMASTER],
    ['(Remastered)', Qualifier.REMASTER],
    ['(2011 Remaster)', Qualifier.REMASTER],
    ['(Remix)', Qualifier.REMIX],
    ['(Remixed)', Qualifier.REMIX],
    ['(Remixes)', Qualifier.REMIX],
    ['(Re-mix)', Qualifier.REMIX],
    ['(Eric Prydz Remix)', Qualifier.REMIX],
    ['(Acoustic)', Qualifier.ACOUSTIC],
    ['(Unplugged)', Qualifier.ACOUSTIC],
    ['(Instrumental)', Qualifier.INSTRUMENTAL],
    ['(Radio Edit)', Qualifier.RADIO_EDIT],
    ['(Radio Mix)', Qualifier.RADIO_EDIT],
    ['(Radio Version)', Qualifier.RADIO_EDIT],
    ['(Extended)', Qualifier.EXTENDED],
    ['(Extended Mix)', Qualifier.EXTENDED],
    ['(Demo)', Qualifier.DEMO],
    ['(Cover)', Qualifier.COVER],
    ['(Karaoke)', Qualifier.KARAOKE],
  ])('%s tags %s', (annotation, qualifier) => {
    const result = peel(`Da Funk ${annotation}`)
    expect(result.base).toBe('Da Funk')
    expect(result.qualifiers).toContain(qualifier)
  })

  it.each([
    'Extended Mix',
    'Original Mix',
    'Album Mix',
    'Radio Mix',
    'Single Mix',
    'Main Mix',
    'Final Mix',
    'Full Mix',
  ])('"%s" is the label\'s own master, not a remix', annotation => {
    // The generic "<word> Mix" pattern would tag these REMIX and send the matcher
    // hunting for a remix that does not exist.
    expect(peel(`Da Funk (${annotation})`).qualifiers).not.toContain(Qualifier.REMIX)
  })

  it.each([
    'Original',
    'Single',
    'Album',
    'Deluxe',
    'Explicit',
    'Clean',
    'Bonus',
    'Stereo',
    'Mono',
  ])('"%s" peels without carrying a qualifier', word => {
    // A version marker with no qualifier of its own. Peeling still improves the match
    // key, which is why it is recognized rather than ignored.
    const result = peel(`Da Funk (${word})`)
    expect(result.base).toBe('Da Funk')
    expect(result.qualifiers).toEqual([])
  })

  it.each(['Mix', 'Version', 'Edit', 'Track', 'Master', 'Cut'])(
    '"Original %s" peels too',
    suffix => {
      expect(peel(`Da Funk (Original ${suffix})`).base).toBe('Da Funk')
    },
  )

  it('keeps an annotation that belongs to the title', () => {
    // The control, and the whole reason `recognized` exists: "(Interlude)" and
    // "(Part 2)" are part of the song's name, and peeling them merges two tracks.
    expect(peel('Da Funk (Interlude)').base).toBe('Da Funk (Interlude)')
    expect(peel('Da Funk (Part 2)').base).toBe('Da Funk (Part 2)')
  })

  it('stops peeling at the first annotation it does not recognize', () => {
    // Right to left. Once something belongs to the title, everything left of it does too.
    expect(peel('Da Funk (Interlude) (Live)').base).toBe('Da Funk (Interlude)')
  })

  it('peels a dash-form annotation as well as a bracketed one', () => {
    expect(peel('Da Funk - Live').base).toBe('Da Funk')
    expect(peel('Da Funk - Live').qualifiers).toContain(Qualifier.LIVE)
  })

  it('survives a hyphenated title', () => {
    expect(peel('Jean-Michel').base).toBe('Jean-Michel')
  })

  it('records the most specific version label verbatim', () => {
    // Matching scores this against candidate titles, so it keeps its original spelling.
    expect(peel('Da Funk (Eric Prydz Remix)').versionLabel).toBe('Eric Prydz Remix')
  })

  it('reports no label when nothing was peeled', () => {
    expect(peel('Da Funk').versionLabel).toBeNull()
  })
})

// ------------------------------------------------------------------ featured artists
describe('featured credits are pulled out of the title', () => {
  it.each([
    'Get Lucky (feat. Pharrell Williams)',
    'Get Lucky (ft. Pharrell Williams)',
    'Get Lucky (featuring Pharrell Williams)',
    'Get Lucky (w/ Pharrell Williams)',
    'Get Lucky feat. Pharrell Williams',
  ])('%j credits Pharrell', raw => {
    const result = stripQualifiers(raw)
    expect(result.base).toBe('Get Lucky')
    expect(result.featured).toEqual(['Pharrell Williams'])
  })

  it('splits several credits', () => {
    expect(splitFeatured('Pharrell Williams & Nile Rodgers')).toEqual([
      'Pharrell Williams',
      'Nile Rodgers',
    ])
    expect(splitFeatured('A, B and C')).toEqual(['A', 'B', 'C'])
  })

  it('keeps the first spelling of a repeated credit, and peels right to left', () => {
    // Two facts at once, and the second is why the first looks backwards. Annotations are
    // peeled from the end of the title, so the credit encountered FIRST is the rightmost
    // one — its spelling is the one kept, and the earlier-written one is the duplicate.
    const result = stripQualifiers('Get Lucky (feat. Pharrell) (ft. pharrell)')
    expect(result.featured).toEqual(['pharrell'])
  })

  it('separates an inline artist credit from the artist name', () => {
    expect(splitArtistCredits('Daft Punk feat. Pharrell')).toEqual(['Daft Punk', ['Pharrell']])
  })

  it('leaves a collaboration joiner intact', () => {
    // "Simon & Garfunkel" is one act. Splitting it makes two artists and matches neither.
    expect(splitArtistCredits('Simon & Garfunkel')).toEqual(['Simon & Garfunkel', []])
  })
})

// ----------------------------------------------------------------- artists and keys
describe('normalizeArtist', () => {
  it('drops a leading "by"', () => {
    expect(normalizeArtist('by M83')).toBe('M83')
  })

  it('drops surrounding list punctuation', () => {
    expect(normalizeArtist('  - M83, ')).toBe('M83')
  })

  it('leaves an ordinary name alone', () => {
    expect(normalizeArtist('Nick Cave and the Bad Seeds')).toBe('Nick Cave and the Bad Seeds')
  })
})

describe('dedupeKey', () => {
  it('ignores case and punctuation', () => {
    expect(dedupeKey('Da Funk!', 'Daft Punk', [])).toBe(dedupeKey('da funk', 'DAFT PUNK', []))
  })

  it('keeps different recordings apart', () => {
    expect(dedupeKey('Da Funk', 'Daft Punk', [Qualifier.LIVE])).not.toBe(
      dedupeKey('Da Funk', 'Daft Punk', []),
    )
  })

  it('does not depend on the order qualifiers arrive in', () => {
    expect(dedupeKey('Da Funk', 'Daft Punk', [Qualifier.LIVE, Qualifier.REMASTER])).toBe(
      dedupeKey('Da Funk', 'Daft Punk', [Qualifier.REMASTER, Qualifier.LIVE]),
    )
  })

  it('keeps different artists apart', () => {
    expect(dedupeKey('Crazy', 'Gnarls Barkley', [])).not.toBe(dedupeKey('Crazy', 'Seal', []))
  })
})

// ------------------------------------------------------------------------- ISRC
describe('normalizeIsrc fails closed', () => {
  it.each([
    ['USRC17607839', 'USRC17607839'],
    ['us-rc1-76-07839', 'USRC17607839'],
    ['  USRC1 76 07839  ', 'USRC17607839'],
  ])('accepts %j', (raw, expected) => {
    expect(normalizeIsrc(raw)).toBe(expected)
  })

  it.each([
    ['too short', 'USRC1760783'],
    ['too long', 'USRC176078390'],
    ['letters where digits belong', 'USRC1760783X'],
    ['digits where the country belongs', '12RC17607839'],
    ['empty', ''],
    ['not an ISRC at all', 'hello'],
  ])('refuses %s', (_label, raw) => {
    // An ISRC short-circuits provider search, so a malformed one would send the matcher
    // looking up a recording that does not exist and silently find nothing.
    expect(normalizeIsrc(raw)).toBeNull()
  })
})

// --------------------------------------------------------------------- durations
describe('parseDuration', () => {
  it.each([
    ['3:45', 225],
    ['03:45', 225],
    ['1:02:17', 3737],
    ['0:30', 30],
  ])('reads %j as %d seconds', (raw, seconds) => {
    expect(parseDuration(raw)).toBe(seconds)
  })

  it.each([
    ['sixty seconds', '3:60'],
    ['no colon', '345'],
    ['empty', ''],
    ['letters', 'three forty five'],
  ])('refuses %s', (_label, raw) => {
    expect(parseDuration(raw)).toBeNull()
  })
})

// ------------------------------------------------------- version annotation detection
describe('hasVersionAnnotation identifies the title side of a pair', () => {
  it.each(['Da Funk (Live)', 'Da Funk [Radio Edit]', 'Da Funk - Remastered', 'Da Funk (Demo)'])(
    '%j carries one',
    text => {
      expect(hasVersionAnnotation(text)).toBe(true)
    },
  )

  it.each(['Daft Punk', 'Nick Cave and the Bad Seeds', 'Da Funk'])('%j does not', text => {
    expect(hasVersionAnnotation(text)).toBe(false)
  })
})
