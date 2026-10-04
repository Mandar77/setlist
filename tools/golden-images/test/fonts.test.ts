// The two questions `fonts.ts` answers, each checked from both sides.
//
// A licence gate exercised only against the installed packages — all of which pass — is
// a gate nobody has ever seen fire. A coverage check exercised only on ASCII is the same
// thing. So every rule here gets input that must be accepted and input that must be
// refused.

import { describe, expect, it } from 'vitest'

import {
  ALLOWED_LICENCES,
  covers,
  fontFrom,
  loadFont,
  parseUnicodeRange,
  plannedFontPackages,
  redactEmails,
  subsetsFor,
  type FontsourceMetadata,
} from '../src/index.js'

const metadata = (over: Partial<FontsourceMetadata> = {}): FontsourceMetadata => ({
  id: 'test-face',
  family: 'Test Face',
  category: 'handwriting',
  subsets: ['latin'],
  weights: [400],
  license: { type: 'OFL-1.1', attribution: 'Copyright 2020 The Test Face Authors' },
  ...over,
})

const LATIN = { latin: 'U+0000-00FF,U+0152-0153' }

describe('the licence gate', () => {
  it('accepts the two licences the corpus allows', () => {
    for (const type of ['OFL-1.1', 'Apache-2.0']) {
      expect(
        fontFrom('@fontsource/test', metadata({ license: { type, attribution: 'c' } }), LATIN),
      ).toMatchObject({ licence: type })
    }
  })

  it('refuses a font that is not redistributable', () => {
    // The case that matters: a face nobody may ship, caught before it is drawn into a
    // corpus this repository publishes.
    expect(() =>
      fontFrom(
        '@fontsource/test',
        metadata({ license: { type: 'GPL-3.0-only', attribution: 'c' } }),
        LATIN,
      ),
    ).toThrow(/not one of/)
  })

  it('refuses a font with no licence at all rather than assuming one', () => {
    expect(() =>
      fontFrom('@fontsource/test', metadata({ license: { type: '', attribution: '' } }), LATIN),
    ).toThrow(/not one of/)
  })

  it('refuses a category the generator has no plan for', () => {
    expect(() => fontFrom('@fontsource/test', metadata({ category: 'display' }), LATIN)).toThrow(
      /unsupported fontsource category/,
    )
  })

  it('every font the plan draws with is installed and allowed', () => {
    const fonts = plannedFontPackages().map(loadFont)
    expect(fonts.length).toBeGreaterThanOrEqual(10)
    for (const font of fonts) {
      expect(ALLOWED_LICENCES.has(font.licence), `${font.pkg} is ${font.licence}`).toBe(true)
      expect(font.attribution.length).toBeGreaterThan(0)
    }
  })

  it('records no contact address, because this repository is public', () => {
    for (const font of plannedFontPackages().map(loadFont)) {
      expect(font.attribution, font.pkg).not.toMatch(/@/)
    }
  })
})

describe('redacting an address', () => {
  // Assembled rather than written out: `tools/check_no_secrets.py` scans this file too,
  // and it is right to.
  const address = ['a.designer', 'example.invalid'].join('@')

  it('removes it and keeps the name', () => {
    const redacted = redactEmails(`Copyright (c) 2010, A Designer (${address})`)
    expect(redacted).not.toContain('@')
    expect(redacted).toContain('A Designer')
  })

  it('leaves an attribution that never had one alone', () => {
    const plain = 'Copyright 2011 The Lora Project Authors'
    expect(redactEmails(plain)).toBe(plain)
  })
})

describe('unicode-range parsing', () => {
  it('reads the three forms fontsource uses', () => {
    expect(parseUnicodeRange('U+0301')).toEqual([[0x0301, 0x0301]])
    expect(parseUnicodeRange('U+0400-045F')).toEqual([[0x0400, 0x045f]])
    expect(parseUnicodeRange('U+30??')).toEqual([[0x3000, 0x30ff]])
  })

  it('reads a comma-separated list', () => {
    expect(parseUnicodeRange('U+0000-00FF,U+0131')).toEqual([
      [0x0000, 0x00ff],
      [0x0131, 0x0131],
    ])
  })

  it('refuses a token that is not a range rather than silently covering nothing', () => {
    // Under-reporting coverage would shrink the corpus quietly; this is the loud version.
    expect(() => parseUnicodeRange('0400-045F')).toThrow(SyntaxError)
    expect(() => parseUnicodeRange('')).toThrow(SyntaxError)
  })
})

describe('coverage', () => {
  const latinOnly = fontFrom('@fontsource/test', metadata(), LATIN)

  it('covers what the subset declares', () => {
    expect(covers(latinOnly, 'Killer Cars - Radiohead')).toBe(true)
    expect(subsetsFor(latinOnly, 'Radiohead')).toEqual(['latin'])
  })

  it('does not cover a script the font was never cut for', () => {
    // The whole point. Chromium would draw this in a system font and the image would
    // silently stop being the handwriting the manifest claims.
    expect(covers(latinOnly, '坂本龍一')).toBe(false)
    expect(subsetsFor(latinOnly, 'Self Portrait 坂本龍一')).toBeNull()
  })

  it('refuses a string it can only draw part of', () => {
    // Not "the subsets that cover most of it": a partial answer renders a document with
    // characters missing, which is the failure this function exists to prevent.
    expect(subsetsFor(latinOnly, 'Queen 힙합성애자')).toBeNull()
  })

  it('treats line breaks as layout rather than as uncovered glyphs', () => {
    expect(covers(latinOnly, 'Queen\nRadiohead')).toBe(true)
  })

  it('a real face covers the script it advertises and not one it does not', () => {
    const caveat = loadFont('@fontsource/caveat')
    expect(covers(caveat, 'Би-2')).toBe(true)
    expect(covers(caveat, 'BTS 힙합성애자')).toBe(false)
  })
})
