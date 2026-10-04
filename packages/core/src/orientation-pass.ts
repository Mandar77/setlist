/**
 * Apply the ADR-002 orientation ladder to a document's parsed lines.
 *
 * `orientation.ts` decides *what* the orientation is from a list of observations. This
 * applies that verdict: it builds the observations from the parser's own output, and
 * rewrites the dash matches that disagree with the document-level answer.
 *
 * ## Why only dash matches are rewritten
 *
 * A dash line is the only shape with no internal evidence of which side is which.
 * `Title by Artist` says so in the text, a quoted title says so with quotes, and a CSV
 * header says so in the header — those are rung-1 cues, and rewriting them from a
 * document-level statistic would be overruling the document with an average of itself.
 * They contribute to the verdict and are never changed by it.
 *
 * ## Why this does nothing without a sourceKind
 *
 * `resolveOrientation` returns null when there is no cue, no convention and no source
 * kind, and this returns the matches untouched in that case. The frozen oracle has no
 * source kind, so every differential input lands in exactly that branch — which is what
 * keeps ADR-001's byte-for-byte parity intact while this feature exists. The ladder can
 * still fire without a source kind when the document carries its own evidence, which is
 * the behaviour ADR-002 actually asks for.
 */

import type { LineMatch } from './parsers/base.js'
import { dashSides } from './parsers/pair.js'
import type { Line } from './models.js'
import type { SourceKind } from './enums.js'
import {
  Orientation,
  type OrientationObservation,
  type OrientationVerdict,
  resolveOrientation,
} from './orientation.js'

/** Parsers whose output states its own orientation, so it counts as a rung-1 cue. */
const CUE_PARSERS = new Set(['by', 'quoted'])

/**
 * Build the ladder's input from the parsed lines.
 *
 * A match from `by` or `quoted` contributes an explicit title-first cue: both shapes put
 * the title first and name the artist second. A dash match contributes its two sides
 * positionally and no cue — it is the thing being decided.
 */
export function observationsFrom(
  lines: readonly Line[],
  matches: readonly LineMatch[],
): OrientationObservation[] {
  const byOffset = new Map(lines.map(line => [line.offset, line]))
  const observations: OrientationObservation[] = []

  for (const match of matches) {
    const line = byOffset.get(match.span.start) ?? findLine(lines, match.span.start)
    if (line === undefined) continue

    if (CUE_PARSERS.has(match.parser)) {
      observations.push({
        left: match.title,
        right: match.artist ?? '',
        cue: Orientation.TITLE_FIRST,
      })
      continue
    }

    if (match.parser !== 'dash') continue
    const sides = dashSides(line)
    if (sides !== null) observations.push({ left: sides[0], right: sides[1], cue: null })
  }

  return observations
}

/** The line a span starts inside. */
function findLine(lines: readonly Line[], start: number): Line | undefined {
  let found: Line | undefined
  for (const line of lines) {
    if (line.offset <= start) found = line
    else break
  }
  return found
}

export interface OrientedMatches {
  readonly matches: readonly LineMatch[]
  /** Null when the ladder had nothing to go on, which is the oracle's case. */
  readonly verdict: OrientationVerdict | null
}

/**
 * Rewrite the dash matches whose orientation disagrees with the document's.
 *
 * The span is untouched by construction: swapping which side is called the title does
 * not move any offset, so an item grounded before the swap is grounded after it. That is
 * what lets ADR-002 step 4's alternate reading exist at all — both readings point at the
 * same text, and ADR-007 grounding holds for both.
 */
export function applyOrientation(
  lines: readonly Line[],
  matches: readonly LineMatch[],
  sourceKind: SourceKind | null,
): OrientedMatches {
  // No source kind, no pass — not even rungs 1 and 2, which could fire without one.
  //
  // This is stricter than ADR-002 describes and the first version did not do it, which
  // broke four pipeline tests immediately: a document whose cue-bearing lines disagree
  // with its dash lines got rewritten, and the extracted titles changed. The oracle has
  // no source kind, so "the ladder may fire on evidence alone" means "the port answers
  // differently from the oracle on inputs the oracle can express", and ADR-001's
  // differential stops measuring the port.
  //
  // `sourceKind` is the opt-in. Until a caller supplies it, this package behaves exactly
  // as it did before ADR-002 — which is what CORE-07 needs to stay true, because that is
  // when the oracle is deleted and the differential stops being able to notice.
  if (sourceKind === null) return { matches, verdict: null }

  const verdict = resolveOrientation(observationsFrom(lines, matches), sourceKind)
  if (verdict === null) return { matches, verdict: null }

  const byOffset = new Map(lines.map(line => [line.offset, line]))
  const rewritten = matches.map(match => {
    if (match.parser !== 'dash') return match

    const line = byOffset.get(match.span.start) ?? findLine(lines, match.span.start)
    if (line === undefined) return match
    const sides = dashSides(line)
    if (sides === null) return match

    // What the parser chose, read off the text rather than inferred from a flag: if the
    // title is the left-hand side, the parser landed on title-first.
    const parserSaidTitleFirst = match.title === sides[0]
    const verdictSaysTitleFirst = verdict.orientation === Orientation.TITLE_FIRST
    if (parserSaidTitleFirst === verdictSaysTitleFirst) return match

    return {
      ...match,
      title: sides[verdictSaysTitleFirst ? 0 : 1]!,
      artist: sides[verdictSaysTitleFirst ? 1 : 0]!,
      // The document has now spoken, so this is no longer the parser's guess. Below the
      // alternate threshold it stays ambiguous, because that is precisely the case
      // ADR-002 sends to matching with both readings.
      ambiguousDirection: verdict.emitAlternate,
    }
  })

  return { matches: rewritten, verdict }
}
