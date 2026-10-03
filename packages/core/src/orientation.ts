/**
 * Which side of "X - Y" is the title (ADR-002).
 *
 * `Wonderwall - Oasis` and `Oasis - Wonderwall` are the same characters in the same
 * order to a parser, and both orderings are in real use. A scan of a handwritten setlist
 * is title-first; a pasted Reddit tracklist is usually artist-first; a DJ cue sheet with
 * timestamps is artist-first; and any of them can be the other way round. Guessing wrong
 * does not produce a near-miss, it produces a search for a song that does not exist.
 *
 * ADR-002 resolves it as a ladder, first match wins, and the confidence attached to each
 * rung is what later stages act on:
 *
 *   1. **Explicit cues** (>=0.95) — "Title by Artist", a quoted title, a CSV header, a
 *      timestamped DJ line. The document said which is which.
 *   2. **Document convention** (~0.85) — the majority orientation among the lines that
 *      DID carry a cue, plus the repetition signal: across a real tracklist the artist
 *      column repeats and the title column does not.
 *   3. **Source-kind prior** (0.60) — scans and screenshots are title-first, pastes and
 *      files are artist-first.
 *   4. **Below 0.8**, emit the swapped reading as `alternate` as well, and let matching
 *      settle it against free catalogs before any YouTube quota is spent.
 *
 * ## Why this is gated on `sourceKind`, and why that is not a hedge
 *
 * The frozen Python oracle has no concept of a source kind: it reads text on stdin and
 * nothing else. Orientation resolution therefore cannot be something the port does to
 * every document, because then the port would answer differently from the oracle on
 * inputs the oracle can express, and ADR-001's differential — 8 golden cases field for
 * field, 10,000 generated inputs by digest — would be measuring the feature instead of
 * the port.
 *
 * `sourceKind` is new information the oracle never receives. A document constructed
 * without one behaves exactly as it does today, which is what keeps the differential
 * honest and `golden/diff-allowlist.yaml` empty. The ladder runs only when the caller
 * supplies the signal ADR-002 added to the ingestion contract.
 *
 * Step 2 does most of the real work. A tracklist is internally consistent, so the side
 * that repeats is the artist — the same statistic the headerless-CSV column inference
 * already uses, generalized to dash lines.
 */

import { SourceKind } from './enums.js'
import { fold } from './normalize.js'

/** Confidence attached to each rung, from the ADR-002 table. */
export const ORIENTATION_CONFIDENCE = Object.freeze({
  EXPLICIT: 0.95,
  CONVENTION: 0.85,
  PRIOR: 0.6,
})

/**
 * Below this, the swapped reading is emitted too and matching decides.
 *
 * It sits above the prior (0.60) and below the convention (0.85) on purpose: a guess
 * made from the source kind alone is never good enough to act on by itself, and a
 * document that showed its own convention is.
 */
export const ALTERNATE_THRESHOLD = 0.8

/** Which side of a pair the title is on. */
export const Orientation = {
  TITLE_FIRST: 'title_first',
  ARTIST_FIRST: 'artist_first',
} as const
export type Orientation = (typeof Orientation)[keyof typeof Orientation]

/** How the orientation was decided, so a reviewer can see the reasoning. */
export const OrientationBasis = {
  EXPLICIT: 'explicit',
  CONVENTION: 'convention',
  PRIOR: 'prior',
} as const
export type OrientationBasis = (typeof OrientationBasis)[keyof typeof OrientationBasis]

export interface OrientationVerdict {
  readonly orientation: Orientation
  readonly confidence: number
  readonly basis: OrientationBasis
  /** True when the swapped reading should also be offered (ADR-002 step 4). */
  readonly emitAlternate: boolean
}

/**
 * Source-kind priors (ADR-002 rung 3).
 *
 * Handwriting, print and screenshots are photographs of setlists and track sheets, which
 * are written title-first. Pasted text and uploaded files are usually copied from a
 * tracklist or a music app, which are artist-first.
 */
const PRIOR: Readonly<Record<SourceKind, Orientation>> = Object.freeze({
  [SourceKind.SCAN_HANDWRITING]: Orientation.TITLE_FIRST,
  [SourceKind.SCAN_PRINT]: Orientation.TITLE_FIRST,
  [SourceKind.SCREENSHOT]: Orientation.TITLE_FIRST,
  [SourceKind.PASTE]: Orientation.ARTIST_FIRST,
  [SourceKind.FILE]: Orientation.ARTIST_FIRST,
})

/** One line's contribution to the document-level statistics. */
export interface OrientationObservation {
  /** The left-hand side of the pair, as parsed. */
  readonly left: string
  /** The right-hand side. */
  readonly right: string
  /**
   * The orientation this line stated for itself, if it carried an explicit cue —
   * `Title by Artist`, a quoted title, a CSV header, a timestamped DJ line.
   */
  readonly cue: Orientation | null
}

function majority(values: readonly Orientation[]): Orientation | null {
  let titleFirst = 0
  for (const value of values) {
    if (value === Orientation.TITLE_FIRST) titleFirst += 1
  }
  const artistFirst = values.length - titleFirst
  if (titleFirst === artistFirst) return null
  return titleFirst > artistFirst ? Orientation.TITLE_FIRST : Orientation.ARTIST_FIRST
}

/**
 * The repetition signal: across a tracklist the artist repeats and the title does not.
 *
 * Returns the orientation the repetition implies, or null when neither side repeats more
 * than the other — which is the common case for a short list and is why this is only one
 * input to rung 2 rather than a rung of its own.
 *
 * Compared on folded keys so "Oasis" and "OASIS " count as the same artist. That is the
 * same key the deduper uses, for the same reason.
 */
export function repetitionSignal(
  observations: readonly OrientationObservation[],
): Orientation | null {
  if (observations.length < 2) return null

  const leftKeys = new Set<string>()
  const rightKeys = new Set<string>()
  for (const observation of observations) {
    leftKeys.add(fold(observation.left))
    rightKeys.add(fold(observation.right))
  }

  // Fewer distinct values on a side means that side repeats, so that side is the artist.
  if (leftKeys.size === rightKeys.size) return null
  return leftKeys.size < rightKeys.size ? Orientation.ARTIST_FIRST : Orientation.TITLE_FIRST
}

/**
 * Resolve the orientation for a document's bare pairs.
 *
 * `sourceKind` of `null` means the caller supplied no signal, which is the oracle's
 * world: there is no prior to fall back to, so a document with no cues and no convention
 * gets no verdict at all and the existing behaviour stands.
 */
export function resolveOrientation(
  observations: readonly OrientationObservation[],
  sourceKind: SourceKind | null,
): OrientationVerdict | null {
  // Rung 1: explicit cues. A document where the cue-bearing lines agree has said which
  // side is which, and nothing below this can overrule it.
  const cues = observations
    .map(observation => observation.cue)
    .filter((cue): cue is Orientation => cue !== null)

  if (cues.length > 0) {
    const agreed = majority(cues)
    if (agreed !== null) {
      return verdict(agreed, ORIENTATION_CONFIDENCE.EXPLICIT, OrientationBasis.EXPLICIT)
    }
    // Cues that contradict each other are not evidence; fall through rather than
    // picking one, because a document that says both things is exactly the case where
    // the alternate reading needs to survive to matching.
  }

  // Rung 2: the document's own convention, from the cue-bearing lines plus repetition.
  const repetition = repetitionSignal(observations)
  if (repetition !== null) {
    return verdict(repetition, ORIENTATION_CONFIDENCE.CONVENTION, OrientationBasis.CONVENTION)
  }

  // Rung 3: the source-kind prior, when the caller gave one.
  if (sourceKind !== null) {
    return verdict(PRIOR[sourceKind], ORIENTATION_CONFIDENCE.PRIOR, OrientationBasis.PRIOR)
  }

  return null
}

function verdict(
  orientation: Orientation,
  confidence: number,
  basis: OrientationBasis,
): OrientationVerdict {
  return Object.freeze({
    orientation,
    confidence,
    basis,
    // Rung 4. Strictly below, so a document convention at exactly 0.85 is acted on and
    // a bare prior at 0.60 is not.
    emitAlternate: confidence < ALTERNATE_THRESHOLD,
  })
}

/** The opposite reading, for the `alternate` ADR-002 step 4 asks for. */
export function swap(orientation: Orientation): Orientation {
  return orientation === Orientation.TITLE_FIRST
    ? Orientation.ARTIST_FIRST
    : Orientation.TITLE_FIRST
}
