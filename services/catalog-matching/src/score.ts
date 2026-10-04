/**
 * Candidate scoring and the confidence thresholds (PRD §7.10.3, §7.10.4).
 *
 * "Weighted title similarity (token-set ratio), artist similarity, duration tolerance
 * (±3 s default), version/qualifier match, popularity tiebreak." Then:
 * **≥0.8 auto-accept; 0.5–0.8 flag for review; <0.5 mark not-found.**
 *
 * Normalization is `packages/core`'s `fold` and `tokens`, not a second implementation.
 * That is not tidiness — a matcher that normalizes differently from the parser scores a
 * candidate against a string the parser never produced, and the disagreement is
 * invisible because both sides look correct in isolation.
 */

import { fold, tokens } from '@setlist/core'
import type { Qualifier } from '@setlist/core'

export interface Candidate {
  readonly title: string
  readonly artist: string | null
  readonly durationS: number | null
  readonly qualifiers: readonly Qualifier[]
  /** Provider popularity, 0–1, used only to break ties. */
  readonly popularity?: number
}

export interface Query {
  readonly title: string
  readonly artist: string | null
  readonly durationS: number | null
  readonly qualifiers: readonly Qualifier[]
}

/** PRD §7.10.3 weights. They sum to 1 before the popularity tiebreak. */
export const WEIGHTS = Object.freeze({
  title: 0.5,
  artist: 0.3,
  duration: 0.1,
  qualifiers: 0.1,
})

/** PRD §7.10.4. */
export const AUTO_ACCEPT = 0.8
export const REVIEW_FLOOR = 0.5

/** Default duration tolerance, in seconds. */
export const DURATION_TOLERANCE_S = 3

export type Verdict = 'auto_accept' | 'review' | 'not_found'

/**
 * Token-set ratio: how much of the smaller token set the two share.
 *
 * Set-based rather than sequence-based on purpose. "Daft Punk - One More Time" and "One
 * More Time (Daft Punk Remix)" reorder and pad; an edit distance punishes that heavily
 * and a set ratio does not, which is the behaviour PRD §7.10.3 asks for by name.
 */
export function tokenSetRatio(a: string, b: string): number {
  const left = new Set(tokens(a))
  const right = new Set(tokens(b))
  if (left.size === 0 && right.size === 0) return 1
  if (left.size === 0 || right.size === 0) return 0

  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / Math.min(left.size, right.size)
}

/** Exact after folding, else token-set. A null on either side is unknown, not wrong. */
export function artistSimilarity(a: string | null, b: string | null): number {
  if (a === null || b === null) return 0.5
  if (fold(a) === fold(b)) return 1
  return tokenSetRatio(a, b)
}

/** 1 inside the tolerance, decaying to 0 by four times it. */
export function durationSimilarity(
  a: number | null,
  b: number | null,
  toleranceS = DURATION_TOLERANCE_S,
): number {
  if (a === null || b === null) return 0.5
  const delta = Math.abs(a - b)
  if (delta <= toleranceS) return 1
  const span = toleranceS * 4
  return delta >= span ? 0 : 1 - (delta - toleranceS) / (span - toleranceS)
}

/**
 * Qualifier agreement.
 *
 * Asymmetric on purpose: a live recording offered for a studio query is a worse error
 * than a studio recording offered for a live query. The first is a different performance
 * of the song; the second is at least the song. So an extra qualifier on the CANDIDATE
 * costs more than a missing one.
 */
export function qualifierSimilarity(
  query: readonly Qualifier[],
  candidate: readonly Qualifier[],
): number {
  const wanted = new Set(query)
  const got = new Set(candidate)
  if (wanted.size === 0 && got.size === 0) return 1

  let missing = 0
  for (const q of wanted) if (!got.has(q)) missing += 1
  let extra = 0
  for (const q of got) if (!wanted.has(q)) extra += 1

  const penalty = missing * 0.25 + extra * 0.5
  return Math.max(0, 1 - penalty)
}

export interface Scored {
  readonly candidate: Candidate
  readonly score: number
  readonly verdict: Verdict
  readonly parts: {
    readonly title: number
    readonly artist: number
    readonly duration: number
    readonly qualifiers: number
  }
}

export function verdictFor(score: number): Verdict {
  if (score >= AUTO_ACCEPT) return 'auto_accept'
  if (score >= REVIEW_FLOOR) return 'review'
  return 'not_found'
}

/**
 * A qualifier the query did not ask for caps the verdict at `review`.
 *
 * Found by a test that should have passed and did not. Within a weighted sum, qualifiers
 * carry 0.1, so the worst possible qualifier mismatch costs 0.1 — an otherwise-perfect
 * live recording offered for a studio query scores 0.95 and auto-accepts. No choice of
 * weight fixes that without distorting the other three factors, because the problem is
 * not that the penalty is too small; it is that the weighted sum is the wrong shape for
 * this one factor.
 *
 * A live take is not a worse match for the studio recording, it is a DIFFERENT recording.
 * Putting it in a playlist unreviewed is the kind of silent wrong answer this project
 * treats as worse than no answer, so it goes to review however well everything else
 * scores. The score itself is left alone — it is still the best description of how close
 * the candidate is, and capping it would lose that.
 */
export function hasUnwantedQualifier(
  query: readonly Qualifier[],
  candidate: readonly Qualifier[],
): boolean {
  const wanted = new Set(query)
  return candidate.some(q => !wanted.has(q))
}

export function scoreCandidate(query: Query, candidate: Candidate): Scored {
  const parts = {
    title: tokenSetRatio(query.title, candidate.title),
    artist: artistSimilarity(query.artist, candidate.artist),
    duration: durationSimilarity(query.durationS, candidate.durationS),
    qualifiers: qualifierSimilarity(query.qualifiers, candidate.qualifiers),
  }
  const score =
    parts.title * WEIGHTS.title +
    parts.artist * WEIGHTS.artist +
    parts.duration * WEIGHTS.duration +
    parts.qualifiers * WEIGHTS.qualifiers

  let verdict = verdictFor(score)
  if (verdict === 'auto_accept' && hasUnwantedQualifier(query.qualifiers, candidate.qualifiers)) {
    verdict = 'review'
  }

  return { candidate, score, verdict, parts }
}

/**
 * Best candidate, popularity breaking ties only.
 *
 * "Only" is load-bearing: popularity is a provider's opinion about what is in demand,
 * not about what the user asked for, so it may separate two equal matches and must never
 * outrank a better one. The epsilon is what keeps it a tiebreak rather than a thumb on
 * the scale.
 */
export function bestMatch(query: Query, candidates: readonly Candidate[]): Scored | null {
  if (candidates.length === 0) return null
  const scored = candidates.map(c => scoreCandidate(query, c))

  return scored.reduce((best, next) => {
    const difference = next.score - best.score
    if (difference > 1e-9) return next
    if (difference < -1e-9) return best
    return (next.candidate.popularity ?? 0) > (best.candidate.popularity ?? 0) ? next : best
  })
}
