/**
 * Per-item confidence scoring and source precedence (FR-004).
 *
 * Confidence lives in one module, separate from the parsers (ADR-007 §5): parsers report
 * what they found and how, and this turns that into a number. Recalibration never
 * touches pattern code.
 */

import { ExtractionMethod } from './enums.js'
import type { Hints } from './models.js'
import { PY_S } from './normalize.js'

// --------------------------------------------------------------------- thresholds
/** FR-007: items below this go to the human-in-the-loop review queue. */
export const REVIEW_THRESHOLD = 0.8
/** PRD §7.10.4 match confidence bands. */
export const AUTO_ACCEPT_THRESHOLD = 0.8
export const NOT_FOUND_THRESHOLD = 0.5

/**
 * A deterministic parser's base score reflects how unambiguous its pattern is, not how
 * often it fires. "dash" is common but genuinely ambiguous about which side is the
 * artist; "quoted" is rarer but self-labelling, so it scores higher.
 */
export const BASE_CONFIDENCE: Readonly<Record<string, number>> = {
  csv: 0.97,
  // A headerless table whose column order could not be corroborated from the data.
  // Scored so that the ambiguity penalty lands it under review rather than
  // auto-accepting a coin flip about which column held the artist.
  csv_headerless: 0.8,
  quoted: 0.95,
  by: 0.92,
  dash: 0.9,
  tab: 0.93,
  // A bare line with no separator: a title with no artist. Parsed, but always sent to
  // review — FR-007 exists precisely for this case.
  bare: 0.55,
}

// ------------------------------------------------------------------- adjustments
/** The separator could not disambiguate artist from title. */
export const PENALTY_AMBIGUOUS_DIRECTION = -0.12
/** No artist was recovered; matching has only a title to work with. */
export const PENALTY_NO_ARTIST = -0.25
/** A single-token title is a weak signal ("Home", "Alive" match thousands of tracks). */
export const PENALTY_SHORT_TITLE = -0.05
/**
 * The title has no alphanumeric content at all — a mis-split, not a song. Numeric and
 * symbolic titles are deliberately *not* penalized: "1979", "99 Problems" and "10%" are
 * all real tracks.
 */
export const PENALTY_DEGENERATE_TITLE = -0.35
/** An ISRC in the source is the canonical key; matching becomes near-exact. */
export const BONUS_ISRC = 0.03
/** A duration lets the matcher reject wrong-length recordings. */
export const BONUS_DURATION = 0.02
/** The line came from an ordered structure, corroborating that it is a track entry. */
export const BONUS_STRUCTURED = 0.02

/**
 * Ceiling applied per extraction method so an LLM item can never outrank a deterministic
 * one on identical evidence.
 */
const METHOD_CEILING: Readonly<Record<ExtractionMethod, number>> = {
  [ExtractionMethod.DETERMINISTIC]: 1.0,
  [ExtractionMethod.HYBRID]: 1.0,
  [ExtractionMethod.LLM_GROUNDED]: 0.85,
  [ExtractionMethod.LLM_UNGROUNDED]: 0.0,
}

/** Constrain a score to the `[0, 1]` interval required by FR-004. */
export function clamp(value: number): number {
  return Math.min(1.0, Math.max(0.0, value))
}

/** The maximum confidence an item produced by `method` may carry. */
export function methodCeiling(method: ExtractionMethod): number {
  return METHOD_CEILING[method]
}

const SPLIT_RE = new RegExp(`${PY_S}+`, 'u')
const STRIP_RE = new RegExp(`^${PY_S}+|${PY_S}+$`, 'gu')

/**
 * Python's `str.isalnum()` for a single character: a letter, a digit, or a numeric
 * character. Not `/[a-z0-9]/i`, which would call every Cyrillic title degenerate and
 * take 0.35 off its score.
 */
const ALNUM_RE = /[\p{L}\p{N}]/u

/** Score a deterministically parsed item. */
export function deterministicConfidence(
  parser: string,
  title: string,
  artist: string | null,
  hints: Hints,
  options: { ambiguousDirection?: boolean; structured?: boolean } = {},
): number {
  const adjustments: number[] = []
  if (options.ambiguousDirection) adjustments.push(PENALTY_AMBIGUOUS_DIRECTION)
  if (!artist) adjustments.push(PENALTY_NO_ARTIST)
  if (
    title
      .replace(STRIP_RE, '')
      .split(SPLIT_RE)
      .filter(w => w !== '').length === 1
  ) {
    adjustments.push(PENALTY_SHORT_TITLE)
  }
  if (!ALNUM_RE.test(title)) adjustments.push(PENALTY_DEGENERATE_TITLE)
  if (hints.isrc) adjustments.push(BONUS_ISRC)
  if (hints.durationS) adjustments.push(BONUS_DURATION)
  if (options.structured) adjustments.push(BONUS_STRUCTURED)

  const base = BASE_CONFIDENCE[parser] ?? BASE_CONFIDENCE['bare']!
  return apply(base, adjustments, ExtractionMethod.DETERMINISTIC)
}

/**
 * Python's `sum()` over floats, which is not a loop that adds.
 *
 * Since 3.12, CPython's builtin `sum` uses Neumaier compensated summation on floats, and
 * it is measurably more accurate than left-to-right addition. `0.55 + sum([-0.25, -0.05,
 * 0.02])` is exactly 0.27 in Python and 0.2700000000000001 with a naive JavaScript
 * reduce — a confidence that differs in the sixteenth decimal place, serializes
 * differently, and fails a byte comparison.
 *
 * Nothing downstream would have cared about the value. The differential test compares
 * bytes, though, and a port that is almost identical is a port nobody can check — so the
 * summation algorithm is part of the behaviour being ported.
 */
function pySum(values: readonly number[]): number {
  let sum = 0
  let compensation = 0
  for (const value of values) {
    const t = sum + value
    compensation += Math.abs(sum) >= Math.abs(value) ? sum - t + value : value - t + sum
    sum = t
  }
  return sum + compensation
}

/** Sum adjustments onto `base` and clamp to the method ceiling. */
function apply(base: number, adjustments: number[], method: ExtractionMethod): number {
  return Math.min(clamp(base + pySum(adjustments)), methodCeiling(method))
}
