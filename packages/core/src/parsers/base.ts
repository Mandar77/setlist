/** Shared types for the deterministic parser family (FR-002). */

import type { Hints, Line, Span } from '../models.js'

/**
 * A deterministic parser's verdict on a single line.
 *
 * Confidence is deliberately absent: parsers report *what* they found and *how* they
 * found it, and `confidence.ts` turns that into a number. Keeping scoring out of the
 * parsers means recalibration never touches pattern code (ADR-007 §5).
 */
export interface LineMatch {
  readonly title: string
  readonly artist: string | null
  readonly span: Span
  readonly parser: string
  readonly hints: Hints
  /** The parser could not tell which side of the separator was the artist. */
  readonly ambiguousDirection: boolean
  /** The line came from an ordered structure (numbered list, cue sheet, CSV row). */
  readonly structured: boolean
}

/** A parser takes one line and either claims it or passes. */
export type LineParser = (line: Line) => LineMatch | null
