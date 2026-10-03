/**
 * The anti-hallucination gate (FR-003, PRD §7.9.4).
 *
 * Every item — deterministic or LLM-produced — must prove that the text it claims to have
 * come from actually says so. An item whose span does not contain its own title is
 * rejected, which is what makes "no hallucinated songs" (G2) a structural property
 * rather than a hope about model behaviour.
 *
 * The check is token coverage rather than substring equality, because legitimate
 * extraction normalizes: `"Jay-Z & Kanye"` may be reported as `"Jay-Z and Kanye"`, and a
 * title may lose a bracketed qualifier that the parser moved into `Hints`.
 */

import { RejectReason } from './enums.js'
import {
  makeRejectedItem,
  MAX_TITLE_LENGTH,
  sliceSpan,
  spanWithin,
  type RejectedItem,
  type SourceDocument,
  type Span,
} from './models.js'
import { tokens } from './normalize.js'

/**
 * An item's span may not exceed this many characters.
 *
 * Without a cap, a span covering the whole document would trivially "contain" any title
 * an attacker or a confused model cared to invent. ADR-001's porting notes call this out
 * by name as behaviour that is easy to lose.
 */
export const MAX_GROUNDING_SPAN = 400
/** Fraction of title tokens that must appear in the span text. */
export const TITLE_COVERAGE = 0.7
/** Artists tolerate more drift — collaborator lists get reordered and abbreviated. */
export const ARTIST_COVERAGE = 0.6

/**
 * Fraction of `claim` tokens present in `source`.
 *
 * An empty claim is fully covered: nothing was asserted, so nothing is unsupported.
 */
export function coverage(claim: readonly string[], source: ReadonlySet<string>): number {
  if (claim.length === 0) return 1.0
  return claim.filter(token => source.has(token)).length / claim.length
}

/**
 * Format a float the way Python's `f"{value:.2f}"` does.
 *
 * Only used inside rejection detail strings, but those strings are compared by the
 * differential test, so "0.50" and "0.5" are not interchangeable here.
 */
function fixed2(value: number): string {
  return value.toFixed(2)
}

/**
 * Verify that `span` supports the claimed title and artist.
 *
 * Returns `null` when the item is grounded, otherwise a `RejectedItem` explaining which
 * check failed. Callers must drop any item that gets a rejection back.
 */
export function ground(
  document: SourceDocument,
  fields: { title: string; artist: string | null; span: Span; parser: string },
): RejectedItem | null {
  const { title, artist, span, parser } = fields

  if (!title.trim()) {
    return makeRejectedItem({ title, artist, reason: RejectReason.EMPTY_TITLE, parser })
  }
  if (title.length > MAX_TITLE_LENGTH) {
    return makeRejectedItem({
      title: title.slice(0, MAX_TITLE_LENGTH),
      artist,
      reason: RejectReason.TITLE_TOO_LONG,
      detail: `${title.length} characters`,
      span,
      parser,
    })
  }
  if (!spanWithin(span, document.text)) {
    return makeRejectedItem({
      title,
      artist,
      reason: RejectReason.SPAN_OUT_OF_RANGE,
      detail: `span ends at ${span.end}, document is ${document.text.length} characters`,
      parser,
    })
  }
  if (span.end - span.start > MAX_GROUNDING_SPAN) {
    return makeRejectedItem({
      title,
      artist,
      reason: RejectReason.SPAN_OUT_OF_RANGE,
      detail: `span covers ${span.end - span.start} characters, limit ${MAX_GROUNDING_SPAN}`,
      span,
      parser,
    })
  }

  const source = new Set(tokens(sliceSpan(span, document.text)))
  const titleScore = coverage(tokens(title), source)
  if (titleScore < TITLE_COVERAGE) {
    return makeRejectedItem({
      title,
      artist,
      reason: RejectReason.SPAN_TEXT_MISMATCH,
      detail: `title token coverage ${fixed2(titleScore)} < ${TITLE_COVERAGE}`,
      span,
      parser,
    })
  }

  if (artist) {
    const artistScore = coverage(tokens(artist), source)
    if (artistScore < ARTIST_COVERAGE) {
      return makeRejectedItem({
        title,
        artist,
        reason: RejectReason.SPAN_TEXT_MISMATCH,
        detail: `artist token coverage ${fixed2(artistScore)} < ${ARTIST_COVERAGE}`,
        span,
        parser,
      })
    }
  }
  return null
}
