/**
 * The deterministic half of the hybrid extractor (PRD §7.9, steps 1-2 and 5).
 *
 * `extractDeterministic` is the whole contract: normalize, parse what the rules can
 * parse, ground every claim against the source, deduplicate, and hand back both the
 * items and the residual spans that the Bedrock pass is responsible for. The residual is
 * the interesting output — it is precisely the text an LLM will see, and nothing else
 * ever reaches the model.
 */

import { deterministicConfidence } from './confidence.js'
import { dedupe } from './dedupe.js'
import { ExtractionMethod } from './enums.js'
import { ground } from './grounding.js'
import {
  documentFromRaw,
  lineSpan,
  makeParsedItem,
  type ExtractionResult,
  type Line,
  type ParsedItem,
  type RejectedItem,
  type SourceDocument,
  type Span,
} from './models.js'
import {
  detectTable,
  isListShaped,
  looksLikeNoise,
  parseLine,
  parseTable,
  splitLines,
  type LineMatch,
} from './parsers/index.js'

/**
 * FR-001 default paste/upload cap.
 *
 * The API layer makes this configurable per environment through AppConfig; the core
 * enforces whatever it is handed.
 */
export const DEFAULT_MAX_INPUT_BYTES = 100 * 1024

/**
 * If the pair parsers already claimed this share of content lines, the rest are headers
 * rather than bare titles — see `shouldRescueWithBareTitles`.
 */
export const BARE_RESCUE_MAX_COVERAGE = 0.5

/** Raised when input exceeds the configured size cap (FR-001, NFR-004). */
export class InputTooLargeError extends Error {
  constructor(
    readonly size: number,
    readonly limit: number,
  ) {
    super(`input is ${size} bytes, limit is ${limit}`)
    this.name = 'InputTooLargeError'
  }
}

/**
 * The UTF-8 byte length of a string, without TextEncoder.
 *
 * The cap is in bytes because that is what a request body is measured in, and a
 * character count would let a document of CJK titles be three times the intended size.
 */
function utf8Length(text: string): number {
  let bytes = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

/** Run the deterministic extraction pass over a document. */
export function extractDeterministic(
  source: string | SourceDocument,
  options: { maxInputBytes?: number } = {},
): ExtractionResult {
  const maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES

  let document: SourceDocument
  if (typeof source === 'string') {
    const size = utf8Length(source)
    if (size > maxInputBytes) throw new InputTooLargeError(size, maxInputBytes)
    document = documentFromRaw(source)
  } else {
    document = source
  }

  const lines = splitLines(document.text)
  const { matches, consumed } = collectMatches(lines)
  const { items, rejected } = groundAll(document, matches)
  const deduped = dedupe(items)

  const residual = residualSpans(lines, matches, consumed)
  return Object.freeze({
    document,
    items: Object.freeze(deduped),
    residual,
    rejected: Object.freeze(rejected),
    stats: Object.freeze({
      linesTotal: lines.length,
      linesParsed: matches.length,
      linesResidual: residual.length,
      itemsBeforeDedupe: items.length,
      itemsAfterDedupe: deduped.length,
      rejected: rejected.length,
    }),
  })
}

/**
 * Parse the document as a table if it is one, otherwise line by line.
 *
 * `consumed` holds the indices of lines that were consumed without producing a match. A
 * CSV header is the motivating case: it is neither a track nor residual, and forwarding
 * it to Bedrock would be pure token spend.
 */
function collectMatches(lines: Line[]): { matches: LineMatch[]; consumed: Set<number> } {
  const spec = detectTable(lines)
  if (spec !== null) {
    const consumed =
      spec.headerRow !== null ? new Set([firstContentLine(lines)]) : new Set<number>()
    return { matches: parseTable(lines, spec), consumed }
  }

  const strict = parseAll(lines, false)
  if (shouldRescueWithBareTitles(lines, strict)) {
    return { matches: parseAll(lines, true), consumed: new Set<number>() }
  }
  return { matches: strict, consumed: new Set<number>() }
}

/** Run the line parsers across the document. */
function parseAll(lines: Line[], allowBare: boolean): LineMatch[] {
  const matches: LineMatch[] = []
  for (const line of lines) {
    const match = parseLine(line, allowBare)
    if (match !== null) matches.push(match)
  }
  return matches
}

/**
 * Decide whether separator-less lines should be read as bare titles.
 *
 * Two conditions, and both matter:
 *
 * * The document has to read as a list at all, or an article's sentence fragments become
 *   songs.
 * * The pair parsers have to have mostly *failed*. On a document where they succeeded,
 *   the leftover lines are headers and section labels — "Best tracks of the summer"
 *   sitting above four "Artist - Title" lines is not a track, and claiming it costs
 *   precision against the G2 gate.
 *
 * ADR-001's porting notes single this out: bare titles rescue documents the pair parsers
 * mostly failed on; they never supplement a document that mostly parsed.
 */
function shouldRescueWithBareTitles(lines: Line[], strict: LineMatch[]): boolean {
  const content = lines.filter(line => !looksLikeNoise(line.text)).length
  if (!content) return false
  if (strict.length / content >= BARE_RESCUE_MAX_COVERAGE) return false
  return isListShaped(lines)
}

/** Index of the first non-noise line, which is where a header row would sit. */
function firstContentLine(lines: Line[]): number {
  const index = lines.findIndex(line => !looksLikeNoise(line.text))
  return index === -1 ? 0 : index
}

/** Score and ground each match, splitting survivors from rejections. */
function groundAll(
  document: SourceDocument,
  matches: LineMatch[],
): { items: ParsedItem[]; rejected: RejectedItem[] } {
  const items: ParsedItem[] = []
  const rejected: RejectedItem[] = []

  for (const match of matches) {
    const rejection = ground(document, {
      title: match.title,
      artist: match.artist,
      span: match.span,
      parser: match.parser,
    })
    if (rejection !== null) {
      rejected.push(rejection)
      continue
    }
    items.push(
      makeParsedItem({
        title: match.title,
        artist: match.artist,
        hints: match.hints,
        span: match.span,
        confidence: deterministicConfidence(match.parser, match.title, match.artist, match.hints, {
          ambiguousDirection: match.ambiguousDirection,
          structured: match.structured,
        }),
        method: ExtractionMethod.DETERMINISTIC,
        parser: match.parser,
      }),
    )
  }
  return { items, rejected }
}

/**
 * Spans of every content line no parser claimed.
 *
 * These go to Bedrock. Noise lines are excluded entirely — sending markdown rules and
 * bare URLs to a model would be pure token spend.
 */
function residualSpans(
  lines: Line[],
  matches: LineMatch[],
  consumed: Set<number>,
): readonly Span[] {
  const starts = lines.map(line => line.offset)
  const claimed = new Set(consumed)
  for (const match of matches) {
    const index = bisectRight(starts, match.span.start) - 1
    if (index >= 0) claimed.add(index)
  }

  const out: Span[] = []
  for (const [index, line] of lines.entries()) {
    if (claimed.has(index)) continue
    if (looksLikeNoise(line.text)) continue
    const span = lineSpan(line)
    if (span !== null) out.push(span)
  }
  return Object.freeze(out)
}

/** Python's `bisect.bisect_right`: the insertion point to the right of equal values. */
function bisectRight(sorted: number[], value: number): number {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (value < sorted[mid]!) high = mid
    else low = mid + 1
  }
  return low
}
