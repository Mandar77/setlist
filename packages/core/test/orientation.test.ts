// The ADR-002 orientation ladder.
//
// Each rung is tested for what it decides AND for what it refuses to decide, because the
// refusals are the interesting half: a ladder whose lower rungs fire when a higher one
// should have is indistinguishable from a working one on the easy cases.
//
// ## Why the assertions use literals and not the module's own constants
//
// The first version of this file compared results against `Orientation.TITLE_FIRST` and
// `ORIENTATION_CONFIDENCE.EXPLICIT`. Twenty-six tests passed and mutation testing killed
// 2 of 65 mutants, because a mutant that rewrites `TITLE_FIRST: 'title_first'` to
// `TITLE_FIRST: ''` changes the produced value and the expected value together. The test
// compares the module against itself and holds for any value at all.
//
// That is the same defect as the SHA-256 test that asserted
// `digest === sha256Hex(normalize(raw))`, found by the same tool, written one session
// after it was documented. The string values are the wire format — `enums.ts` says they
// must stay byte-identical to the oracle's — so the literal IS the contract, and a test
// that cannot see a changed literal is not testing the contract.

import { describe, expect, it } from 'vitest'

import { SourceKind } from '../src/enums.js'
import {
  ALTERNATE_THRESHOLD,
  ORIENTATION_CONFIDENCE,
  Orientation,
  OrientationBasis,
  repetitionSignal,
  resolveOrientation,
  swap,
} from '../src/orientation.js'

/** A line that carried no cue of its own. */
const plain = (left: string, right: string) => ({ left, right, cue: null })
/** A line that stated its own orientation. */
const cued = (left: string, right: string, cue: Orientation) => ({ left, right, cue })

describe('the wire values themselves', () => {
  // Pinned as literals, because everything else in this file depends on them being what
  // they say they are, and because they cross a process boundary to the oracle.
  it('Orientation is exactly these two strings', () => {
    expect(Orientation).toEqual({ TITLE_FIRST: 'title_first', ARTIST_FIRST: 'artist_first' })
  })

  it('OrientationBasis is exactly these three strings', () => {
    expect(OrientationBasis).toEqual({
      EXPLICIT: 'explicit',
      CONVENTION: 'convention',
      PRIOR: 'prior',
    })
  })

  it('the ADR-002 confidences are 0.95, 0.85 and 0.60', () => {
    expect(ORIENTATION_CONFIDENCE).toEqual({ EXPLICIT: 0.95, CONVENTION: 0.85, PRIOR: 0.6 })
  })

  it('the alternate threshold is 0.8', () => {
    expect(ALTERNATE_THRESHOLD).toBe(0.8)
  })

  it('the threshold sits between the prior and the convention', () => {
    // A property over the literals above: moving any one number without the others
    // breaks this rather than silently changing which documents get a second reading.
    expect(ORIENTATION_CONFIDENCE.PRIOR).toBeLessThan(ALTERNATE_THRESHOLD)
    expect(ORIENTATION_CONFIDENCE.CONVENTION).toBeGreaterThanOrEqual(ALTERNATE_THRESHOLD)
    expect(ORIENTATION_CONFIDENCE.EXPLICIT).toBeGreaterThan(ORIENTATION_CONFIDENCE.CONVENTION)
  })
})

describe('rung 1: explicit cues', () => {
  it('wins outright, at 0.95', () => {
    const verdict = resolveOrientation(
      [cued('Wonderwall', 'Oasis', Orientation.TITLE_FIRST)],
      SourceKind.PASTE,
    )
    expect(verdict).toEqual({
      orientation: 'title_first',
      confidence: 0.95,
      basis: 'explicit',
      emitAlternate: false,
    })
  })

  it('overrules a source-kind prior that says the opposite', () => {
    // SCAN_HANDWRITING's prior is title-first. An explicit artist-first cue beats it,
    // which is the entire point of "evidence overrides defaults".
    const verdict = resolveOrientation(
      [cued('Oasis', 'Wonderwall', Orientation.ARTIST_FIRST)],
      SourceKind.SCAN_HANDWRITING,
    )
    expect(verdict?.orientation).toBe('artist_first')
    expect(verdict?.basis).toBe('explicit')
    expect(verdict?.confidence).toBe(0.95)
  })

  it('overrules a repetition signal pointing the other way', () => {
    // Left side repeats, so repetition alone would say artist-first. The cues say
    // title-first and they are a higher rung.
    const verdict = resolveOrientation(
      [
        cued('Oasis', 'Wonderwall', Orientation.TITLE_FIRST),
        cued('Oasis', 'Live Forever', Orientation.TITLE_FIRST),
      ],
      null,
    )
    expect(verdict?.basis).toBe('explicit')
    expect(verdict?.orientation).toBe('title_first')
  })

  it('falls through when the cues contradict each other', () => {
    // Two cues, one each way. A document that says both things has not said anything,
    // and picking one would be inventing evidence. It must drop to a lower rung.
    const verdict = resolveOrientation(
      [cued('A', 'B', Orientation.TITLE_FIRST), cued('C', 'D', Orientation.ARTIST_FIRST)],
      SourceKind.PASTE,
    )
    expect(verdict?.basis).toBe('prior')
    expect(verdict?.confidence).toBe(0.6)
  })

  it('a majority of agreeing cues still counts as explicit', () => {
    const verdict = resolveOrientation(
      [
        cued('A', 'B', Orientation.TITLE_FIRST),
        cued('C', 'D', Orientation.TITLE_FIRST),
        cued('E', 'F', Orientation.ARTIST_FIRST),
      ],
      null,
    )
    expect(verdict?.basis).toBe('explicit')
    expect(verdict?.orientation).toBe('title_first')
  })
})

describe('rung 2: document convention', () => {
  it('reads the repeating side as the artist, at 0.85', () => {
    // Three titles, one artist. The artist column repeats; the title column does not.
    const verdict = resolveOrientation(
      [plain('Oasis', 'Wonderwall'), plain('Oasis', 'Live Forever'), plain('Oasis', 'Supersonic')],
      null,
    )
    expect(verdict).toEqual({
      orientation: 'artist_first',
      confidence: 0.85,
      basis: 'convention',
      emitAlternate: false,
    })
  })

  it('reads it the other way when the right side repeats', () => {
    const verdict = resolveOrientation(
      [plain('Wonderwall', 'Oasis'), plain('Live Forever', 'Oasis'), plain('Supersonic', 'Oasis')],
      null,
    )
    expect(verdict?.orientation).toBe('title_first')
    expect(verdict?.basis).toBe('convention')
    expect(verdict?.confidence).toBe(0.85)
  })

  it('beats the source-kind prior', () => {
    // PASTE's prior is artist-first. The document's own convention is title-first and
    // says so by repetition, which is a higher rung.
    const verdict = resolveOrientation(
      [plain('Wonderwall', 'Oasis'), plain('Live Forever', 'Oasis')],
      SourceKind.PASTE,
    )
    expect(verdict?.orientation).toBe('title_first')
    expect(verdict?.basis).toBe('convention')
  })
})

describe('repetitionSignal on its own', () => {
  it('is null for a single line — one line has no convention', () => {
    expect(repetitionSignal([plain('Oasis', 'Wonderwall')])).toBeNull()
  })

  it('is null for an empty list', () => {
    expect(repetitionSignal([])).toBeNull()
  })

  it('is null when neither side repeats, which is the common short list', () => {
    expect(repetitionSignal([plain('Oasis', 'Wonderwall'), plain('Blur', 'Song 2')])).toBeNull()
  })

  it('folds before comparing, so casing and spacing do not split an artist', () => {
    // "OASIS " and "Oasis" must count as one artist, or the repetition is invisible.
    expect(repetitionSignal([plain('OASIS ', 'Wonderwall'), plain('Oasis', 'Live Forever')])).toBe(
      'artist_first',
    )
  })

  it('does not fire when both sides repeat equally', () => {
    expect(repetitionSignal([plain('A', 'B'), plain('A', 'B'), plain('C', 'D')])).toBeNull()
  })

  it('says artist_first when the LEFT side has fewer distinct values', () => {
    expect(repetitionSignal([plain('X', 'a'), plain('X', 'b'), plain('X', 'c')])).toBe(
      'artist_first',
    )
  })

  it('says title_first when the RIGHT side has fewer distinct values', () => {
    expect(repetitionSignal([plain('a', 'X'), plain('b', 'X'), plain('c', 'X')])).toBe(
      'title_first',
    )
  })
})

describe('rung 3: the source-kind prior', () => {
  it.each([
    ['scan_handwriting', 'title_first'],
    ['scan_print', 'title_first'],
    ['screenshot', 'title_first'],
    ['paste', 'artist_first'],
    ['file', 'artist_first'],
  ])('%s defaults to %s at 0.60', (kind, expected) => {
    const verdict = resolveOrientation([plain('X', 'Y')], kind as SourceKind)
    expect(verdict?.orientation).toBe(expected)
    expect(verdict?.confidence).toBe(0.6)
    expect(verdict?.basis).toBe('prior')
  })

  it('covers every SourceKind — a new one must not silently have no prior', () => {
    for (const kind of Object.values(SourceKind)) {
      expect(resolveOrientation([plain('X', 'Y')], kind)).not.toBeNull()
    }
  })

  it('SourceKind is exactly these five strings', () => {
    expect(Object.values(SourceKind).sort()).toEqual([
      'file',
      'paste',
      'scan_handwriting',
      'scan_print',
      'screenshot',
    ])
  })
})

describe('no signal at all', () => {
  it('returns null when there is no cue, no convention and no source kind', () => {
    // This is the oracle's world, and the reason the differential still passes: a
    // document built without a sourceKind gets no verdict, so nothing changes.
    expect(resolveOrientation([plain('Oasis', 'Wonderwall')], null)).toBeNull()
  })

  it('returns null for an empty document with no source kind', () => {
    expect(resolveOrientation([], null)).toBeNull()
  })

  it('still answers from the prior when a source kind IS given', () => {
    expect(resolveOrientation([], SourceKind.PASTE)?.basis).toBe('prior')
  })
})

describe('rung 4: the alternate reading', () => {
  it('is emitted below 0.8, which is exactly the bare prior', () => {
    const verdict = resolveOrientation([plain('X', 'Y')], SourceKind.PASTE)
    expect(verdict?.confidence).toBe(0.6)
    expect(verdict?.emitAlternate).toBe(true)
  })

  it('is NOT emitted for a document convention', () => {
    const verdict = resolveOrientation(
      [plain('Oasis', 'Wonderwall'), plain('Oasis', 'Live Forever')],
      null,
    )
    expect(verdict?.confidence).toBe(0.85)
    expect(verdict?.emitAlternate).toBe(false)
  })

  it('is NOT emitted for an explicit cue', () => {
    const verdict = resolveOrientation([cued('Wonderwall', 'Oasis', Orientation.TITLE_FIRST)], null)
    expect(verdict?.emitAlternate).toBe(false)
  })
})

describe('swap', () => {
  it('maps each value to the other', () => {
    expect(swap(Orientation.TITLE_FIRST)).toBe('artist_first')
    expect(swap(Orientation.ARTIST_FIRST)).toBe('title_first')
  })

  it('is its own inverse', () => {
    for (const orientation of Object.values(Orientation)) {
      expect(swap(swap(orientation))).toBe(orientation)
    }
  })
})
