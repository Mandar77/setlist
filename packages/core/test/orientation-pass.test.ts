// Applying the ADR-002 verdict to parsed lines.
//
// The load-bearing test in this file is the first one: without a `sourceKind`, nothing
// changes. That is not a nicety, it is what keeps ADR-001's differential measuring the
// port instead of this feature, and the first version of the pass failed it — four
// pipeline tests broke the moment rungs 1 and 2 were allowed to fire on evidence alone.

import { describe, expect, it } from 'vitest'

import { SourceKind } from '../src/enums.js'
import { extractDeterministic } from '../src/pipeline.js'

const TITLE_FIRST_DOC = ['Wonderwall - Oasis', 'Live Forever - Oasis', 'Supersonic - Oasis'].join(
  '\n',
)

describe('without a sourceKind, nothing changes', () => {
  it('leaves the verdict null', () => {
    expect(extractDeterministic(TITLE_FIRST_DOC).orientation).toBeNull()
  })

  it('produces byte-identical items with and without the option absent', () => {
    const implicit = extractDeterministic(TITLE_FIRST_DOC)
    const explicitNull = extractDeterministic(TITLE_FIRST_DOC, { sourceKind: null })
    expect(explicitNull.items).toEqual(implicit.items)
    expect(explicitNull.orientation).toBeNull()
  })

  it('keeps the parser default even when the document contradicts it', () => {
    // Every line here repeats "Oasis" on the RIGHT, so rung 2 would say title-first. With
    // no sourceKind the ladder must not run at all, so the artist-first default stands.
    const result = extractDeterministic(TITLE_FIRST_DOC)
    expect(result.items.map(i => i.title)).toEqual(['Oasis', 'Oasis', 'Oasis'])
  })
})

describe('with a sourceKind, the document convention wins', () => {
  it('rewrites the dash lines and reports the basis', () => {
    const result = extractDeterministic(TITLE_FIRST_DOC, { sourceKind: SourceKind.PASTE })
    expect(result.orientation).toEqual({
      orientation: 'title_first',
      confidence: 0.85,
      basis: 'convention',
      emitAlternate: false,
    })
    expect(result.items.map(i => i.title).sort()).toEqual([
      'Live Forever',
      'Supersonic',
      'Wonderwall',
    ])
    expect(result.items.map(i => i.artist)).toEqual(['Oasis', 'Oasis', 'Oasis'])
  })

  it('leaves the spans untouched, so grounding still holds', () => {
    // ADR-002 step 4 depends on this: both readings point at the same text, so an item
    // grounded before the swap is grounded after it. Nothing is rejected.
    const before = extractDeterministic(TITLE_FIRST_DOC)
    const after = extractDeterministic(TITLE_FIRST_DOC, { sourceKind: SourceKind.PASTE })
    expect(after.items.map(i => i.span)).toEqual(before.items.map(i => i.span))
    expect(after.rejected).toHaveLength(0)
  })

  it('falls back to the prior when the document shows no convention', () => {
    // Two lines, nothing repeating on either side: rung 2 declines, rung 3 answers.
    const result = extractDeterministic('Wonderwall - Oasis\nSong 2 - Blur', {
      sourceKind: SourceKind.SCAN_HANDWRITING,
    })
    expect(result.orientation?.basis).toBe('prior')
    expect(result.orientation?.orientation).toBe('title_first')
    expect(result.orientation?.emitAlternate).toBe(true)
  })

  it('a handwriting scan reads title-first where a paste reads artist-first', () => {
    // The same bytes, two source kinds, two answers — which is the whole point of rung 3.
    const text = 'Wonderwall - Oasis\nSong 2 - Blur'
    const scan = extractDeterministic(text, { sourceKind: SourceKind.SCAN_HANDWRITING })
    const paste = extractDeterministic(text, { sourceKind: SourceKind.PASTE })
    expect(scan.items.map(i => i.title)).toEqual(['Wonderwall', 'Song 2'])
    expect(paste.items.map(i => i.title)).toEqual(['Oasis', 'Blur'])
  })
})

describe('what the pass refuses to rewrite', () => {
  it('leaves a `by` line alone and lets it drive the verdict', () => {
    // "Title by Artist" states its own orientation. It is a rung-1 cue, so it decides
    // the document — and rewriting it from a document-level average would be overruling
    // the document with a summary of itself.
    const result = extractDeterministic('Wonderwall by Oasis\nOasis - Live Forever', {
      sourceKind: SourceKind.PASTE,
    })
    expect(result.orientation?.basis).toBe('explicit')
    expect(result.orientation?.orientation).toBe('title_first')

    const byItem = result.items.find(i => i.parser === 'by')
    expect(byItem?.title).toBe('Wonderwall')
    expect(byItem?.artist).toBe('Oasis')

    // ...and the dash line on the next row is flipped to match the cue.
    const dashItem = result.items.find(i => i.parser === 'dash')
    expect(dashItem?.title).toBe('Oasis')
    expect(dashItem?.artist).toBe('Live Forever')
  })

  it('leaves a bare title alone — there is no second side to swap', () => {
    const result = extractDeterministic('Wonderwall\nLive Forever\nSupersonic', {
      sourceKind: SourceKind.SCAN_HANDWRITING,
    })
    for (const item of result.items) expect(item.artist).toBeNull()
  })
})

describe('every source kind is accepted end to end', () => {
  it.each(['scan_handwriting', 'scan_print', 'screenshot', 'paste', 'file'])(
    '%s produces a verdict',
    kind => {
      const result = extractDeterministic('Wonderwall - Oasis', {
        sourceKind: kind as SourceKind,
      })
      expect(result.orientation).not.toBeNull()
    },
  )
})

describe('the alternate reading (ADR-002 step 4)', () => {
  const ambiguous = ['Wonderwall - Oasis', 'Song 2 - Blur'].join('\n')

  it('is attached below 0.8 and shares the item span', () => {
    const result = extractDeterministic(ambiguous, { sourceKind: SourceKind.SCAN_PRINT })
    expect(result.orientation?.emitAlternate).toBe(true)
    for (const item of result.items) {
      expect(item.alternate).toEqual({ title: item.artist, artist: item.title })
    }
    // The span is the item's own, so grounding holds for both readings. Nothing rejected.
    expect(result.rejected).toHaveLength(0)
  })

  it('is NOT attached when the document settled it above 0.8', () => {
    const settled = extractDeterministic(TITLE_FIRST_DOC, { sourceKind: SourceKind.PASTE })
    expect(settled.orientation?.emitAlternate).toBe(false)
    for (const item of settled.items) expect(item.alternate).toBeUndefined()
  })

  it('is not attached to a bare title — there is no second side', () => {
    const result = extractDeterministic(['Wonderwall', 'Live Forever'].join('\n'), {
      sourceKind: SourceKind.SCAN_PRINT,
    })
    for (const item of result.items) expect(item.alternate).toBeUndefined()
  })
})
