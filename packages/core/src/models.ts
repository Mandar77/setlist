/**
 * Domain models for extraction.
 *
 * Every model here is immutable. Extraction is a pipeline of pure transformations, and
 * frozen models make it impossible for a later stage to silently mutate an earlier
 * stage's output — which matters because spans are cross-referenced against the document
 * long after the parser that produced them has returned.
 *
 * ## Porting note: where zod goes, and where it does not
 *
 * ADR-001 says "zod replaces the pydantic models at the boundary", and the boundary is
 * the operative word. Pydantic validated on every construction, including the thousands
 * of intermediate objects a parse allocates; zod on that path would put a schema walk
 * between every line of input and its result, on a function with a p95 budget of six
 * seconds that also runs on a phone.
 *
 * So the split is: plain `readonly` interfaces and cheap constructors inside the
 * pipeline, which throw exactly where pydantic raised; zod schemas exported for the
 * edges — the API request, the LLM's JSON, anything crossing a process boundary. Both
 * describe the same shapes, and `models.test.ts` asserts they agree.
 */

import { z } from 'zod'

import { ExtractionMethod, Qualifier, RejectReason } from './enums.js'
import { dedupeKey, normalizeDocument, pyStrip } from './normalize.js'
import { sha256Hex } from './sha256.js'

/** A title longer than this is prose that a parser mis-split, not a song title. */
export const MAX_TITLE_LENGTH = 300

/**
 * A half-open character range `[start, end)` into `SourceDocument.text`.
 *
 * FR-003 requires every extracted item to carry a span; items without a valid one are
 * rejected rather than shown, which is what makes hallucinated songs structurally
 * impossible to surface.
 */
export interface Span {
  readonly start: number
  readonly end: number
}

export function makeSpan(start: number, end: number): Span {
  if (!Number.isInteger(start) || start < 0) {
    throw new RangeError(`span start must be a non-negative integer, got ${start}`)
  }
  if (!Number.isInteger(end) || end <= 0) {
    throw new RangeError(`span end must be a positive integer, got ${end}`)
  }
  if (end <= start) {
    throw new RangeError(`span end ${end} must be greater than start ${start}`)
  }
  return Object.freeze({ start, end })
}

/** The substring this span covers. */
export function sliceSpan(span: Span, text: string): string {
  return text.slice(span.start, span.end)
}

/** Whether this span lies inside `text`. */
export function spanWithin(span: Span, text: string): boolean {
  return span.end <= text.length
}

/** This span translated by `offset` characters. */
export function shiftSpan(span: Span, offset: number): Span {
  return makeSpan(span.start + offset, span.end + offset)
}

/**
 * Normalized input text plus the provenance needed to reason about it.
 *
 * `text` is the canonical coordinate system for all spans. `digest` is a stable content
 * hash used as a cache key and to prove that a confirmed job is operating on the same
 * text that was previewed.
 */
export interface SourceDocument {
  readonly text: string
  readonly rawLength: number
  readonly digest: string
}

/**
 * Normalize `raw` and wrap it as a document.
 *
 * Two things here are easy to get wrong and both were found by the differential test.
 *
 * The oracle's models inherit `ConfigDict(str_strip_whitespace=True)`, so pydantic
 * strips **every** string field on construction — including `text`. A trailing newline
 * on a pasted list therefore never reaches the document, and every span indexes into the
 * stripped text. The port had to reproduce that explicitly; without it `lines_total` was
 * 7 where the oracle said 6, on every case whose text ended in a newline.
 *
 * And the digest is computed on the text BEFORE that strip, because `from_raw` hashes
 * its local variable and pydantic strips afterwards. So `digest` is not the hash of
 * `text`. That is surprising enough to be worth stating: it is the hash of the
 * normalized input, which is the stable identity of what the user actually submitted.
 */
export function documentFromRaw(raw: string): SourceDocument {
  const normalized = normalizeDocument(raw)
  return Object.freeze({
    text: pyStrip(normalized),
    rawLength: raw.length,
    digest: sha256Hex(normalized),
  })
}

/**
 * A physical line of the document together with its absolute offset.
 *
 * Deliberately a plain object rather than a validated model: the line splitter allocates
 * one per input line on the hot preview path (NFR-001, p95 < 6 s), and validation there
 * buys nothing.
 */
export interface Line {
  readonly text: string
  readonly offset: number
}

export function makeLine(text: string, offset: number): Line {
  return Object.freeze({ text, offset })
}

/** The span covering this line, or `null` when the line is empty. */
export function lineSpan(line: Line): Span | null {
  if (!line.text) return null
  return makeSpan(line.offset, line.offset + line.text.length)
}

/** A span for `line.text.slice(start, end)` in document coordinates. */
export function lineSub(line: Line, start: number, end: number): Span {
  return makeSpan(line.offset + start, line.offset + end)
}

/**
 * Structured side information attached to a parsed item.
 *
 * These feed matching, not display: `isrc` short-circuits provider search (PRD §7.10.1),
 * `qualifiers` and `durationS` break ties between a studio cut and a live or remixed
 * one, and `featuredArtists` recovers credits folded into a title.
 */
export interface Hints {
  readonly album: string | null
  readonly year: number | null
  readonly isrc: string | null
  readonly durationS: number | null
  readonly featuredArtists: readonly string[]
  readonly qualifiers: readonly Qualifier[]
  readonly versionLabel: string | null
  readonly position: number | null
  readonly timestampS: number | null
}

export const EMPTY_HINTS: Hints = Object.freeze({
  album: null,
  year: null,
  isrc: null,
  durationS: null,
  featuredArtists: Object.freeze([]),
  qualifiers: Object.freeze([]),
  versionLabel: null,
  position: null,
  timestampS: null,
})

export function makeHints(partial: Partial<Hints> = {}): Hints {
  const merged = { ...EMPTY_HINTS, ...partial }
  // pydantic's `str_strip_whitespace` reaches string fields inside collections too.
  return Object.freeze({
    ...merged,
    album: merged.album === null ? null : pyStrip(merged.album),
    isrc: merged.isrc === null ? null : pyStrip(merged.isrc),
    versionLabel: merged.versionLabel === null ? null : pyStrip(merged.versionLabel),
    featuredArtists: Object.freeze(merged.featuredArtists.map(pyStrip)),
    qualifiers: Object.freeze([...merged.qualifiers]),
  })
}

/**
 * Combine two hint sets, preferring `self`'s populated scalar fields.
 *
 * `position` and `timestampS` use an explicit null check rather than `||` because zero
 * is a meaningful value for both and falsy in JavaScript — the oracle writes
 * `if self.position is not None`, and `self.position or other.position` would quietly
 * discard a zero. That is the same shape as the zero-ordinal crash the regression suite
 * carries.
 */
export function mergeHints(self: Hints, other: Hints): Hints {
  const featured = [...self.featuredArtists]
  for (const name of other.featuredArtists) if (!featured.includes(name)) featured.push(name)

  return Object.freeze({
    album: self.album ?? other.album,
    year: self.year ?? other.year,
    isrc: self.isrc ?? other.isrc,
    durationS: self.durationS ?? other.durationS,
    featuredArtists: Object.freeze(featured),
    qualifiers: Object.freeze([...new Set([...self.qualifiers, ...other.qualifiers])]),
    versionLabel: self.versionLabel ?? other.versionLabel,
    position: self.position !== null ? self.position : other.position,
    timestampS: self.timestampS !== null ? self.timestampS : other.timestampS,
  })
}

/** One song extracted from the source text. */
export interface ParsedItem {
  readonly title: string
  readonly artist: string | null
  readonly hints: Hints
  readonly span: Span
  readonly confidence: number
  readonly method: ExtractionMethod
  readonly parser: string
  /** Spans of the other occurrences collapsed into this item by deduplication. */
  readonly duplicates: readonly Span[]
}

export function makeParsedItem(fields: {
  title: string
  artist?: string | null
  hints?: Hints
  span: Span
  confidence: number
  method: ExtractionMethod
  parser: string
  duplicates?: readonly Span[]
}): ParsedItem {
  const title = pyStrip(fields.title)
  if (title.length < 1) throw new RangeError('title must not be empty')
  if (title.length > MAX_TITLE_LENGTH) {
    throw new RangeError(`title is ${title.length} characters, limit is ${MAX_TITLE_LENGTH}`)
  }
  const artist =
    fields.artist === undefined || fields.artist === null ? null : pyStrip(fields.artist)
  if (artist !== null && artist.length < 1) throw new RangeError('artist must not be empty')
  if (fields.confidence < 0 || fields.confidence > 1 || Number.isNaN(fields.confidence)) {
    throw new RangeError(`confidence must be in [0, 1], got ${fields.confidence}`)
  }
  if (fields.parser.length < 1) throw new RangeError('parser must not be empty')

  return Object.freeze({
    title,
    artist,
    hints: fields.hints ?? EMPTY_HINTS,
    span: fields.span,
    confidence: fields.confidence,
    method: fields.method,
    parser: pyStrip(fields.parser),
    duplicates: Object.freeze([...(fields.duplicates ?? [])]),
  })
}

/** The FR-004 deduplication key for this item. */
export function itemKey(item: ParsedItem): string {
  return dedupeKey(item.title, item.artist, item.hints.qualifiers)
}

/** How many times this song appeared in the source text. */
export function occurrenceCount(item: ParsedItem): number {
  return 1 + item.duplicates.length
}

/**
 * A candidate dropped before the preview, retained for auditability.
 *
 * Rejections are surfaced in the API response and logged: G2 ("no hallucinated songs")
 * is only credible if we can show what was thrown away and why.
 */
export interface RejectedItem {
  readonly title: string
  readonly artist: string | null
  readonly reason: RejectReason
  readonly detail: string
  readonly span: Span | null
  readonly parser: string
}

export function makeRejectedItem(fields: {
  title: string
  artist?: string | null
  reason: RejectReason
  detail?: string
  span?: Span | null
  parser?: string
}): RejectedItem {
  return Object.freeze({
    title: pyStrip(fields.title),
    artist: fields.artist === undefined || fields.artist === null ? null : pyStrip(fields.artist),
    reason: fields.reason,
    detail: pyStrip(fields.detail ?? ''),
    span: fields.span ?? null,
    parser: pyStrip(fields.parser ?? 'unknown'),
  })
}

/** Counters emitted as EMF metrics for the extraction dashboard (NFR-006). */
export interface ExtractionStats {
  readonly linesTotal: number
  readonly linesParsed: number
  readonly linesResidual: number
  readonly itemsBeforeDedupe: number
  readonly itemsAfterDedupe: number
  readonly rejected: number
}

export const EMPTY_STATS: ExtractionStats = Object.freeze({
  linesTotal: 0,
  linesParsed: 0,
  linesResidual: 0,
  itemsBeforeDedupe: 0,
  itemsAfterDedupe: 0,
  rejected: 0,
})

/**
 * Fraction of non-noise lines the deterministic pass resolved.
 *
 * Drives the decision to escalate to the LLM pass and, at the fleet level, tells us
 * whether a new source format has appeared that deserves its own parser.
 */
export function deterministicCoverage(stats: ExtractionStats): number {
  const considered = stats.linesParsed + stats.linesResidual
  return considered ? stats.linesParsed / considered : 1.0
}

/** The output of the deterministic pass and, later, of the hybrid merge. */
export interface ExtractionResult {
  readonly document: SourceDocument
  readonly items: readonly ParsedItem[]
  /**
   * Lines the deterministic pass could not resolve. These are what gets sent to Bedrock
   * in the residual pass (PRD §7.9.3) — nothing else is.
   */
  readonly residual: readonly Span[]
  readonly rejected: readonly RejectedItem[]
  readonly stats: ExtractionStats
}

/** Concatenate the residual lines for the LLM pass, one per line. */
export function residualText(result: ExtractionResult): string {
  return result.residual.map(span => sliceSpan(span, result.document.text)).join('\n')
}

/** Items needing human review (FR-007, default threshold 0.8). */
export function below(result: ExtractionResult, threshold: number): readonly ParsedItem[] {
  return result.items.filter(item => item.confidence < threshold)
}

// ---------------------------------------------------------------- zod, at the edges

const qualifierSchema = z.enum(Object.values(Qualifier) as [Qualifier, ...Qualifier[]])

export const spanSchema = z
  .object({ start: z.number().int().min(0), end: z.number().int().positive() })
  .refine(s => s.end > s.start, { message: 'span end must be greater than start' })

export const hintsSchema = z.object({
  album: z.string().nullable().default(null),
  year: z.number().int().min(1860).max(2200).nullable().default(null),
  isrc: z
    .string()
    .regex(/^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/u)
    .nullable()
    .default(null),
  durationS: z.number().positive().nullable().default(null),
  featuredArtists: z.array(z.string()).default([]),
  qualifiers: z.array(qualifierSchema).default([]),
  versionLabel: z.string().nullable().default(null),
  position: z.number().int().min(1).nullable().default(null),
  timestampS: z.number().int().min(0).nullable().default(null),
})

export const parsedItemSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
  artist: z.string().min(1).nullable().default(null),
  // Spelled out rather than `default(() => EMPTY_HINTS)`: the internal `Hints` is deeply
  // `readonly` and zod's default wants a mutable shape. Converting it would mean copying
  // the arrays on every parse of a payload that usually omits the field entirely.
  hints: hintsSchema.default({
    album: null,
    year: null,
    isrc: null,
    durationS: null,
    featuredArtists: [],
    qualifiers: [],
    versionLabel: null,
    position: null,
    timestampS: null,
  }),
  span: spanSchema,
  confidence: z.number().min(0).max(1),
  method: z.enum(Object.values(ExtractionMethod) as [ExtractionMethod, ...ExtractionMethod[]]),
  parser: z.string().min(1),
  duplicates: z.array(spanSchema).default([]),
})

export const rejectedItemSchema = z.object({
  title: z.string(),
  artist: z.string().nullable().default(null),
  reason: z.enum(Object.values(RejectReason) as [RejectReason, ...RejectReason[]]),
  detail: z.string().default(''),
  span: spanSchema.nullable().default(null),
  parser: z.string().default('unknown'),
})

export const sourceDocumentSchema = z.object({
  text: z.string(),
  rawLength: z.number().int().min(0),
  digest: z.string().regex(/^[0-9a-f]{64}$/u),
})
