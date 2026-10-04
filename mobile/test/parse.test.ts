// The paste-to-parsed-list view model (M1-07).
//
// This is where M1-07's done_when items are actually checked. The screen that renders
// this is a layout and nothing else, so if a rule is going to be proven anywhere short of
// an emulator, it is proven here.

import { describe, expect, it } from 'vitest'

import { extractDeterministic } from '@setlist/core'

import { parseForDisplay } from '../src/parse.js'

const LIST = [
  'Queen - Bohemian Rhapsody',
  'Radiohead - Karma Police',
  'Daft Punk - One More Time',
].join('\n')

describe('a pasted list', () => {
  const view = parseForDisplay(LIST)

  it('parses every line', () => {
    expect(view.items).toHaveLength(3)
    expect(view.notice).toBeNull()
  })

  it('shows title, artist and confidence for each item', () => {
    for (const item of view.items) {
      expect(item.title.length).toBeGreaterThan(0)
      expect(item.artist).not.toBeNull()
      expect(item.confidence).toBeGreaterThan(0)
      expect(item.confidence).toBeLessThanOrEqual(1)
      expect(item.confidenceLabel).toMatch(/^\d\.\d{2}$/)
    }
  })

  it('makes the source line reachable from each item', () => {
    // done_when: "the source line is reachable from each". Reachable means the text the
    // item was read from, not a reconstruction of it.
    const titles = view.items.map(item => item.title)
    expect(titles).toContain('Bohemian Rhapsody')
    for (const item of view.items) {
      expect(item.sourceLine).toContain(item.title)
      if (item.artist !== null) expect(item.sourceLine).toContain(item.artist)
    }
  })

  it('gives each item a key that is unique', () => {
    expect(new Set(view.items.map(item => item.key)).size).toBe(view.items.length)
  })
})

describe('the source line is sliced from the normalized text', () => {
  it('stays aligned when normalization changes the length before it', () => {
    // The ADR-007 span contract, exercised against the case that would hide it. U+FB01
    // is the ﬁ ligature; NFKC expands it to two characters, so every span after it sits
    // one position further along in the normalized text than in the raw paste. Slicing
    // the raw string would be correct on pure ASCII — which is to say, correct on every
    // casual test and wrong on this one.
    //
    // Built with fromCodePoint rather than written literally, because an editor or a
    // formatter that normalizes this file would silently delete the thing under test.
    const ligature = String.fromCodePoint(0xfb01)
    const raw = [`${ligature}rst set`, 'Queen - Bohemian Rhapsody'].join('\n')

    const view = parseForDisplay(raw)
    const queen = view.items.find(item => item.title === 'Bohemian Rhapsody')
    expect(queen, 'the Queen line should parse').toBeDefined()
    expect(queen!.sourceLine).toBe('Queen - Bohemian Rhapsody')

    // And the premise: normalization really did change the length here, so the test is
    // not quietly passing on a document where raw and normalized agree.
    const document = extractDeterministic(raw).document
    expect(document.text.length).toBeGreaterThan(raw.length)
  })
})

describe('grounding', () => {
  it('renders only what the core grounded', () => {
    // ADR-007: an ungrounded claim is never shown. This holds structurally — the view
    // reads `result.items` and never `result.rejected` — so what is asserted here is
    // that the two really are separate fields and the count is surfaced instead.
    const view = parseForDisplay(LIST)
    const result = extractDeterministic(LIST)
    expect(view.items).toHaveLength(result.items.length)
    expect(view.rejectedCount).toBe(result.rejected.length)
  })

  it('carries a span that indexes the document it came from', () => {
    const view = parseForDisplay(LIST)
    const text = extractDeterministic(LIST).document.text
    for (const item of view.items) {
      expect(item.span.start).toBeGreaterThanOrEqual(0)
      expect(item.span.end).toBeLessThanOrEqual(text.length)
      expect(text.slice(item.span.start, item.span.end)).toBe(item.sourceLine)
    }
  })
})

describe('nothing to show', () => {
  it('says so for an empty paste', () => {
    expect(parseForDisplay('').notice).toMatch(/Paste a song list/)
    expect(parseForDisplay('   \n  ').items).toEqual([])
  })

  it('says so when the text parses to nothing, rather than showing a blank list', () => {
    // done_when: "a paste that parses to nothing says so, rather than showing an empty
    // screen". An empty list is indistinguishable from a broken screen.
    const view = parseForDisplay('hey are you coming tonight? bring the thing')
    expect(view.items).toEqual([])
    expect(view.notice).toMatch(/No songs found/)
  })

  it('explains a paste that is over the limit instead of throwing', () => {
    // `extractDeterministic` throws InputTooLargeError by contract. A screen that lets
    // that reach an error boundary is worse than one that states the limit.
    const huge = 'Queen - Bohemian Rhapsody\n'.repeat(100)
    const view = parseForDisplay(huge, { maxInputBytes: 64 })
    expect(view.items).toEqual([])
    expect(view.notice).toMatch(/limit is/)
  })
})

describe('the paste is data', () => {
  it('passes text through unchanged rather than interpreting it', () => {
    // The CLAUDE.md guardrail. There is no interpreter on this path, so the check is
    // that text which looks like markup or a template survives verbatim.
    const raw = '${process.exit(1)} - <script>alert(1)</script>'
    const view = parseForDisplay(raw)
    const rendered = view.items.map(item => `${item.title}${item.artist ?? ''}${item.sourceLine}`)
    for (const text of rendered) {
      expect(typeof text).toBe('string')
    }
    // Whatever it parsed to, every character shown came out of the document.
    const text = extractDeterministic(raw).document.text
    for (const item of view.items) {
      expect(text).toContain(item.sourceLine)
    }
  })

  it('returns only plain data, never anything callable', () => {
    const view = parseForDisplay(LIST)
    for (const item of view.items) {
      for (const value of Object.values(item)) {
        expect(typeof value).not.toBe('function')
      }
    }
  })
})

describe('qualifiers and alternates', () => {
  it('surfaces qualifiers the core peeled off', () => {
    const view = parseForDisplay('Queen - Bohemian Rhapsody (Live)')
    expect(view.items).toHaveLength(1)
    expect(view.items[0]!.qualifiers).toContain('live')
  })

  it('surfaces the alternate reading when orientation is unsettled', () => {
    // ADR-002: with `sourceKind: paste` and nothing else to go on, the parser emits the
    // artist-first reading plus an alternate. The screen has to be able to show it,
    // because autonomous creation never proceeds while it is set.
    const view = parseForDisplay('Wonderwall - Oasis', { sourceKind: 'paste' })
    expect(view.items).toHaveLength(1)
    expect(view.items[0]!.alternate).not.toBeNull()
  })

  it('leaves the alternate null when there is nothing to disambiguate', () => {
    const view = parseForDisplay(LIST)
    expect(view.items.every(item => item.alternate === null)).toBe(true)
  })
})
