/**
 * Deterministic parser registry (FR-002).
 *
 * The registry is ordered by how explicitly each pattern labels its own structure. A tab
 * is a column boundary, quotes name the title outright, `by` says it in words, and a
 * dash only implies it by convention — so they are tried in that order and the first
 * claim wins.
 */

import { makeLine, mergeHints, type Line } from '../models.js'
import { stripPrefixes, stripSuffixes } from './affixes.js'
import type { LineMatch, LineParser } from './base.js'
import { parseBare, parseBy, parseDash, parseQuoted, parseTab } from './pair.js'
import { looksLikeNoise } from './noise.js'

export type { LineMatch, LineParser } from './base.js'
export { detectTable, parseTable, type TableSpec } from './csv-table.js'
export { isListShaped, looksLikeNoise, looksLikeProse } from './noise.js'

/** Tried in order; the first parser to claim the line wins. */
export const LINE_PARSERS: readonly LineParser[] = [parseTab, parseQuoted, parseBy, parseDash]

/**
 * Split normalized document text into lines carrying absolute offsets.
 *
 * Offsets are exact: line `n` starts at the sum of all preceding line lengths plus one
 * newline each. Anything downstream that builds a `Span` depends on this.
 */
export function splitLines(text: string): Line[] {
  const lines: Line[] = []
  let offset = 0
  for (const raw of text.split('\n')) {
    lines.push(makeLine(raw, offset))
    offset += raw.length + 1
  }
  return lines
}

/** The first parser verdict for an affix-stripped line. */
function firstMatch(core: Line, allowBare: boolean): LineMatch | null {
  for (const parser of LINE_PARSERS) {
    const match = parser(core)
    if (match !== null) return match
  }
  return allowBare ? parseBare(core) : null
}

/**
 * Run the deterministic parsers against a single line.
 *
 * `allowBare` permits a separator-less line to parse as a title with no artist. Only
 * pass `true` when `isListShaped` has approved the document.
 */
export function parseLine(line: Line, allowBare = false): LineMatch | null {
  if (looksLikeNoise(line.text)) return null

  const prefix = stripPrefixes(line)
  const suffix = stripSuffixes(prefix.line)
  if (!suffix.line.text.trim()) return null

  const affixHints = mergeHints(prefix.hints, suffix.hints)
  const structured = affixHints.position !== null || affixHints.timestampS !== null

  const match = firstMatch(suffix.line, allowBare)
  if (match === null) return null

  return {
    ...match,
    hints: mergeHints(match.hints, affixHints),
    structured: match.structured || structured,
  }
}
