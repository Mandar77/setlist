/**
 * The regression suite ADR-001 says to port, and the porting notes it says to cover.
 *
 * > Port the regression tests before the code — the zero-ordinal crash and both
 * > precision bugs found at M0 are all in the suite.
 *
 * I ported them after, under a differential test that compares every function and the
 * whole pipeline against the frozen oracle. That is the stronger instrument but a
 * different one: a differential proves the port *agrees with the oracle*, not that
 * either is right, and it would go on agreeing if both were wrong. These tests say what
 * the behaviour is and why, so a future deliberate change — the kind CORE-07 allows once
 * the oracle is retired and there is nothing left to diff against — has to argue with a
 * named bug rather than with a hash.
 *
 * Every case here carries the thing that must still pass next to the thing that must
 * fail. A test that only asserts `position === null` for "0." is satisfied by deleting
 * ordinals altogether; the one that asserts "1." still records 1 is what makes it a
 * regression test rather than a tombstone.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { RejectReason } from '../src/enums.js'
import { ground, MAX_GROUNDING_SPAN, coverage } from '../src/grounding.js'
import { documentFromRaw, hintsSchema, makeLine, makeSpan } from '../src/models.js'
import { tokens } from '../src/normalize.js'
import { stripPrefixes } from '../src/parsers/affixes.js'
import { parseBy, parseDash } from '../src/parsers/pair.js'
import { extractDeterministic } from '../src/pipeline.js'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src')

/** Titles of everything a document extracted, in order. */
const titlesOf = (text: string): string[] => extractDeterministic(text).items.map(i => i.title)

// ---------------------------------------------------------------- the zero-ordinal crash
describe('a zero-indexed list is scaffolding, not position zero', () => {
  // Found by Hypothesis at M0. "0." is a perfectly ordinary list marker — zero-indexed
  // tracklists are written by programmers and by anyone whose DJ software counts from
  // zero — but `position` is a 1-based ordinal, so recording 0 violated the model and
  // 500'd /parse. The fix is not "stop matching 0."; the marker still has to be eaten,
  // or the title becomes "0. Da Funk".
  it('consumes the marker without recording a position', () => {
    const { line, hints } = stripPrefixes(makeLine('0. Daft Punk - Da Funk', 0))
    expect(line.text).toBe('Daft Punk - Da Funk')
    expect(hints.position).toBeNull()
  })

  it('still records a position for every other ordinal', () => {
    // The half that makes the test above a regression rather than a deletion.
    expect(stripPrefixes(makeLine('1. Daft Punk - Da Funk', 0)).hints.position).toBe(1)
    expect(stripPrefixes(makeLine('12) Daft Punk - Da Funk', 0)).hints.position).toBe(12)
  })

  it('parses a zero-indexed list end to end', () => {
    expect(titlesOf('0. Daft Punk - Da Funk\n1. Justice - Genesis')).toEqual(['Da Funk', 'Genesis'])
  })

  it('keeps the model constraint that turned the bug into a crash', () => {
    // The 500 came from the schema, and the schema is right: there is no track zero.
    // Deleting the constraint would also have "fixed" the crash, by letting a
    // meaningless ordinal through to the matcher.
    expect(hintsSchema.safeParse({ position: 0 }).success).toBe(false)
    expect(hintsSchema.safeParse({ position: 1 }).success).toBe(true)
  })

  it('does not let a zero position be lost to a falsy check', () => {
    // `self.position or other.position` discards a zero, and zero is a value `timestampS`
    // genuinely takes — a cue sheet starts at 00:00. Same shape as the crash above, one
    // merge away.
    const { hints } = stripPrefixes(makeLine('00:00 Daft Punk - Da Funk', 0))
    expect(hints.timestampS).toBe(0)
  })
})

// ------------------------------------------------------- precision bug 1: the leading year
describe('a leading year is not an ordinal', () => {
  // "1979 - Smashing Pumpkins" is a release-year list, not a numbered one. Read as an
  // ordinal it lost the year *and* the artist: the marker was consumed, leaving
  // "Smashing Pumpkins" as a bare title with position 1979. The ordinal regex is capped
  // at three digits, which is the whole fix.
  it('leaves a four-digit year in the line', () => {
    const { line, hints } = stripPrefixes(makeLine('1979 - Smashing Pumpkins', 0))
    expect(line.text).toBe('1979 - Smashing Pumpkins')
    expect(hints.position).toBeNull()
  })

  it('still reads a three-digit ordinal', () => {
    // Playlists do run past 99. The cap is a cap, not a blanket refusal to count.
    expect(stripPrefixes(makeLine('137. Daft Punk - Da Funk', 0)).hints.position).toBe(137)
  })

  it('keeps the year as the pair parser sees it', () => {
    const match = parseDash(makeLine('1979 - Smashing Pumpkins', 0))
    expect(match).not.toBeNull()
    expect(match!.artist).toBe('1979')
    expect(match!.title).toBe('Smashing Pumpkins')
  })

  it('extracts a year-prefixed list without eating the years', () => {
    const items = extractDeterministic(
      '1979 - Smashing Pumpkins\n1991 - Nirvana\n1994 - Weezer',
    ).items
    expect(items.map(i => i.title)).toEqual(['Smashing Pumpkins', 'Nirvana', 'Weezer'])
    expect(items.every(i => i.hints.position === null)).toBe(true)
  })
})

// -------------------------------------------------- precision bug 2: production credits
describe('a production credit is not a song', () => {
  // "Produced by Rick Rubin" has the exact shape the `by` parser exists for, and it
  // names no track. Left alone it manufactured a song called "Produced" on most
  // real-world articles — a precision loss against G2 that no amount of recall makes up
  // for, because the user sees a song nobody listed.
  //
  // There are three defences here and they overlap, which is a problem for a test: the
  // obvious cases are each caught by more than one, so disabling any single defence left
  // the suite green. These four are chosen so that every defence is the *only* thing
  // standing between the parser and a fabricated song.
  it.each([
    // Only the credit-prefix regex: "artwork" is not a participle and "Vaughan Oliver"
    // is an ordinary two-word name.
    ['Artwork by Vaughan Oliver', 'the credit prefix'],
    // Only the participle check: the line starts with "Our", so no prefix matches, and
    // "the editors" is not a determiner phrase — "The" is deliberately absent from that
    // list because bands begin with it.
    ['Our picks, compiled by the editors', 'the participle before "by"'],
    // Only the determiner check.
    ['Midnight City by a contributor', 'the determiner'],
    // All three, which is the case anyone would have written by hand.
    ['Produced by Rick Rubin', 'all three'],
  ])('rejects %j — %s', raw => {
    expect(parseBy(makeLine(raw, 0))).toBeNull()
  })

  it('still parses a real by-form line', () => {
    // Without this, "reject everything with `by` in it" passes the test above and costs
    // the parser its entire reason to exist.
    const match = parseBy(makeLine('Midnight City by M83', 0))
    expect(match).not.toBeNull()
    expect(match!.artist).toBe('M83')
    expect(match!.title).toBe('Midnight City')
  })

  it('does not invent a song from a credit line in a real document', () => {
    const titles = titlesOf(
      [
        'Midnight City by M83',
        'Genesis by Justice',
        'Da Funk by Daft Punk',
        'Produced by Rick Rubin',
      ].join('\n'),
    )
    expect(titles).toEqual(['Midnight City', 'Genesis', 'Da Funk'])
    expect(titles).not.toContain('Produced')
  })
})

// ------------------------------------------------------------- ADR-001's porting notes
describe('spans index normalized text, which is not the same length as the raw input', () => {
  // The first porting note, and the one with no symptom until it has a bad one: an
  // offset computed against raw bytes lands mid-word once NFKC or zero-width stripping
  // has changed a length, and the item is then "grounded" in text it does not come from.
  // Built from code points on purpose. A literal zero-width space in a source file is
  // invisible to every reviewer and survives a copy-paste into a diff as nothing at all,
  // which is the same class of damage CLAUDE.md bans heredocs for.
  const ZWSP = String.fromCodePoint(0x200b)
  const FULLWIDTH_HYPHEN = String.fromCodePoint(0xff0d)
  const RAW = [
    `1. Daft${ZWSP}Punk ${FULLWIDTH_HYPHEN} Da Funk`,
    `2. Justice ${FULLWIDTH_HYPHEN} Genesis`,
    ``,
  ].join(String.fromCodePoint(10))

  it('changes length during normalization', () => {
    const document = documentFromRaw(RAW)
    expect(document.text.length).not.toBe(RAW.length)
    expect(document.rawLength).toBe(RAW.length)
  })

  it('grounds every item in the normalized text', () => {
    const document = documentFromRaw(RAW)
    const result = extractDeterministic(document)
    expect(result.items.length).toBeGreaterThan(0)
    for (const item of result.items) {
      const slice = document.text.slice(item.span.start, item.span.end)
      const source = new Set(tokens(slice))
      expect(coverage(tokens(item.title), source)).toBe(1)
    }
  })

  it('would not ground against the raw input', () => {
    // The must-fail direction. If spans indexed raw text this suite would pass anyway
    // and the drift would surface on a device, months later, as a title cut in half.
    const document = documentFromRaw(RAW)
    const last = extractDeterministic(document).items.at(-1)!
    expect(RAW.slice(last.span.start, last.span.end)).not.toBe(
      document.text.slice(last.span.start, last.span.end),
    )
  })
})

describe('grounding needs the span-size cap, not only token coverage', () => {
  // Second porting note. Token coverage alone is satisfied by any span large enough to
  // contain the words, so a span covering the whole document grounds anything that
  // appears anywhere in it. That is exactly the shape of a hallucinated item assembled
  // from two different lines — and ADR-007 says an ungrounded item is never shown, which
  // is only true if "grounded" means something.
  const document = documentFromRaw(`${'filler words here. '.repeat(30)}Da Funk`)
  const claim = { title: 'Da Funk', artist: null, parser: 'bare' }

  it('rejects a span wider than the cap even when the title is inside it', () => {
    const wide = makeSpan(document.text.length - MAX_GROUNDING_SPAN - 1, document.text.length)
    expect(document.text.slice(wide.start, wide.end)).toContain('Da Funk')
    const rejection = ground(document, { ...claim, span: wide })
    expect(rejection?.reason).toBe(RejectReason.SPAN_OUT_OF_RANGE)
  })

  it('accepts the same claim inside a span at the cap', () => {
    const start = document.text.length - MAX_GROUNDING_SPAN
    expect(ground(document, { ...claim, span: makeSpan(start, document.text.length) })).toBeNull()
  })

  it('still rejects a small span that does not contain the title', () => {
    // The cap is an additional gate, not a replacement for coverage.
    const rejection = ground(document, { ...claim, span: makeSpan(0, 19) })
    expect(rejection?.reason).toBe(RejectReason.SPAN_TEXT_MISMATCH)
  })
})

describe('confidence lives in one module, separate from the parsers', () => {
  // Third porting note, and the only one that is a shape rather than a behaviour — so it
  // is checked as a shape. A parser that scores its own matches makes recalibration a
  // pattern-code edit, which is how the Python core got a scoring constant in three
  // places that drifted apart.
  const PARSERS = [
    'parsers/pair.ts',
    'parsers/affixes.ts',
    'parsers/csv-table.ts',
    'parsers/noise.ts',
    'parsers/index.ts',
  ]

  it.each(PARSERS)('%s does not import confidence', name => {
    expect(readFileSync(resolve(SRC, name), 'utf8')).not.toMatch(/from '\.\.?\/confidence\.js'/u)
  })

  it('finds the imports it is looking for when they exist', () => {
    // A regex that matched nothing would pass every case above forever.
    expect(readFileSync(resolve(SRC, 'pipeline.ts'), 'utf8')).toMatch(/from '\.\/confidence\.js'/u)
  })
})

describe('bare titles rescue a document, they never supplement one', () => {
  // Fourth porting note. On a list the pair parsers mostly failed on, a separator-less
  // line is a track. On a list they mostly succeeded on, the leftovers are headers and
  // section labels — and claiming them is the single largest precision loss available,
  // because every article has a heading.
  it('reads bare titles when the pair parsers found almost nothing', () => {
    expect(titlesOf('Bohemian Rhapsody\nUnder Pressure\nDon’t Stop Me Now')).toEqual([
      'Bohemian Rhapsody',
      'Under Pressure',
      'Don’t Stop Me Now',
    ])
  })

  it('does not claim the header of a list that parsed', () => {
    const titles = titlesOf(
      [
        'Best tracks of the summer',
        'Daft Punk - Da Funk',
        'Justice - Genesis',
        'M83 - Midnight City',
        'Air - La Femme d’Argent',
      ].join('\n'),
    )
    expect(titles).toEqual(['Da Funk', 'Genesis', 'Midnight City', 'La Femme d’Argent'])
    expect(titles).not.toContain('Best tracks of the summer')
  })

  it('leaves the unclaimed header as residual for the LLM pass', () => {
    // Not claiming it is only half the requirement: a dropped line is a line the
    // residual pass can never recover, and the header may well name the playlist.
    const result = extractDeterministic(
      [
        'Best tracks of the summer',
        'Daft Punk - Da Funk',
        'Justice - Genesis',
        'M83 - Midnight City',
        'Air - La Femme d’Argent',
      ].join('\n'),
    )
    const residual = result.residual.map(span => result.document.text.slice(span.start, span.end))
    expect(residual).toContain('Best tracks of the summer')
  })
})
