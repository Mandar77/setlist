// The ADR-002 orientation ladder.
//
// Each rung is tested for what it decides AND for what it refuses to decide, because the
// refusals are the interesting half: a ladder whose lower rungs fire when a higher one
// should have is indistinguishable from a working one on the easy cases.

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

describe('rung 1: explicit cues', () => {
  it('wins outright, at 0.95', () => {
    const verdict = resolveOrientation(
      [cued('Wonderwall', 'Oasis', Orientation.TITLE_FIRST)],
      SourceKind.PASTE,
    )
    expect(verdict).toEqual({
      orientation: Orientation.TITLE_FIRST,
      confidence: ORIENTATION_CONFIDENCE.EXPLICIT,
      basis: OrientationBasis.EXPLICIT,
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
    expect(verdict?.orientation).toBe(Orientation.ARTIST_FIRST)
    expect(verdict?.basis).toBe(OrientationBasis.EXPLICIT)
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
    expect(verdict?.basis).toBe(OrientationBasis.EXPLICIT)
    expect(verdict?.orientation).toBe(Orientation.TITLE_FIRST)
  })

  it('falls through when the cues contradict each other', () => {
    // Two cues, one each way. A document that says both things has not said anything,
    // and picking one would be inventing evidence. It must drop to a lower rung.
    const verdict = resolveOrientation(
      [cued('A', 'B', Orientation.TITLE_FIRST), cued('C', 'D', Orientation.ARTIST_FIRST)],
      SourceKind.PASTE,
    )
    expect(verdict?.basis).not.toBe(OrientationBasis.EXPLICIT)
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
      orientation: Orientation.ARTIST_FIRST,
      confidence: ORIENTATION_CONFIDENCE.CONVENTION,
      basis: OrientationBasis.CONVENTION,
      emitAlternate: false,
    })
  })

  it('reads it the other way when the right side repeats', () => {
    const verdict = resolveOrientation(
      [plain('Wonderwall', 'Oasis'), plain('Live Forever', 'Oasis'), plain('Supersonic', 'Oasis')],
      null,
    )
    expect(verdict?.orientation).toBe(Orientation.TITLE_FIRST)
    expect(verdict?.basis).toBe(OrientationBasis.CONVENTION)
  })

  it('beats the source-kind prior', () => {
    // PASTE's prior is artist-first. The document's own convention is title-first and
    // says so by repetition, which is a higher rung.
    const verdict = resolveOrientation(
      [plain('Wonderwall', 'Oasis'), plain('Live Forever', 'Oasis')],
      SourceKind.PASTE,
    )
    expect(verdict?.orientation).toBe(Orientation.TITLE_FIRST)
    expect(verdict?.basis).toBe(OrientationBasis.CONVENTION)
  })
})

describe('repetitionSignal on its own', () => {
  it('is null for a single line — one line has no convention', () => {
    expect(repetitionSignal([plain('Oasis', 'Wonderwall')])).toBeNull()
  })

  it('is null when neither side repeats, which is the common short list', () => {
    expect(repetitionSignal([plain('Oasis', 'Wonderwall'), plain('Blur', 'Song 2')])).toBeNull()
  })

  it('folds before comparing, so casing and spacing do not split an artist', () => {
    // "OASIS " and "Oasis" must count as one artist, or the repetition is invisible.
    const signal = repetitionSignal([plain('OASIS ', 'Wonderwall'), plain('Oasis', 'Live Forever')])
    expect(signal).toBe(Orientation.ARTIST_FIRST)
  })

  it('does not fire when both sides repeat equally', () => {
    expect(repetitionSignal([plain('A', 'B'), plain('A', 'B'), plain('C', 'D')])).toBeNull()
  })
})

describe('rung 3: the source-kind prior', () => {
  it.each([
    [SourceKind.SCAN_HANDWRITING, Orientation.TITLE_FIRST],
    [SourceKind.SCAN_PRINT, Orientation.TITLE_FIRST],
    [SourceKind.SCREENSHOT, Orientation.TITLE_FIRST],
    [SourceKind.PASTE, Orientation.ARTIST_FIRST],
    [SourceKind.FILE, Orientation.ARTIST_FIRST],
  ])('%s defaults to %s at 0.60', (kind, expected) => {
    const verdict = resolveOrientation([plain('X', 'Y')], kind)
    expect(verdict?.orientation).toBe(expected)
    expect(verdict?.confidence).toBe(ORIENTATION_CONFIDENCE.PRIOR)
    expect(verdict?.basis).toBe(OrientationBasis.PRIOR)
  })

  it('covers every SourceKind — a new one must not silently have no prior', () => {
    for (const kind of Object.values(SourceKind)) {
      expect(resolveOrientation([plain('X', 'Y')], kind)).not.toBeNull()
    }
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
    expect(resolveOrientation([], SourceKind.PASTE)).not.toBeNull()
  })
})

describe('rung 4: the alternate reading', () => {
  it('is emitted below 0.8, which is exactly the bare prior', () => {
    const verdict = resolveOrientation([plain('X', 'Y')], SourceKind.PASTE)
    expect(verdict?.confidence).toBeLessThan(ALTERNATE_THRESHOLD)
    expect(verdict?.emitAlternate).toBe(true)
  })

  it('is NOT emitted for a document convention', () => {
    const verdict = resolveOrientation(
      [plain('Oasis', 'Wonderwall'), plain('Oasis', 'Live Forever')],
      null,
    )
    expect(verdict?.confidence).toBeGreaterThanOrEqual(ALTERNATE_THRESHOLD)
    expect(verdict?.emitAlternate).toBe(false)
  })

  it('is NOT emitted for an explicit cue', () => {
    const verdict = resolveOrientation([cued('Wonderwall', 'Oasis', Orientation.TITLE_FIRST)], null)
    expect(verdict?.emitAlternate).toBe(false)
  })

  it('the threshold sits between the prior and the convention', () => {
    // Stated as a property rather than left implicit in three separate numbers: moving
    // any one of them without moving the others should break this.
    expect(ORIENTATION_CONFIDENCE.PRIOR).toBeLessThan(ALTERNATE_THRESHOLD)
    expect(ORIENTATION_CONFIDENCE.CONVENTION).toBeGreaterThanOrEqual(ALTERNATE_THRESHOLD)
    expect(ORIENTATION_CONFIDENCE.EXPLICIT).toBeGreaterThan(ORIENTATION_CONFIDENCE.CONVENTION)
  })
})

describe('swap', () => {
  it('is its own inverse', () => {
    for (const orientation of Object.values(Orientation)) {
      expect(swap(swap(orientation))).toBe(orientation)
    }
  })

  it('actually changes the value', () => {
    expect(swap(Orientation.TITLE_FIRST)).toBe(Orientation.ARTIST_FIRST)
    expect(swap(Orientation.ARTIST_FIRST)).toBe(Orientation.TITLE_FIRST)
  })
})
