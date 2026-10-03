/**
 * Line triage: structural noise, prose, and list shape.
 *
 * Three outcomes matter, and conflating them is the classic way to lose recall:
 *
 * * **Noise** — markdown rules, headings, code fences, bare URLs. Dropped outright; it
 *   never reaches a parser and never reaches Bedrock.
 * * **Prose** — sentences that may well mention songs. Never bare-parsed, always routed
 *   to the residual LLM pass (PRD §7.9.3), which is the component that can read it.
 * * **Everything else** — offered to the deterministic pattern parsers.
 *
 * Being too eager here costs recall against G2; being too timid costs Bedrock tokens.
 * The bias is deliberately toward passing things through to the LLM.
 */

import type { Line } from '../models.js'
import { PY_NOT_S, PY_S, PY_WS } from '../normalize.js'

const RULE_RE = new RegExp(`^${PY_S}*[-=*_~]{3,}${PY_S}*$`, 'u')
const MD_HEADING_RE = new RegExp(`^${PY_S}*#{1,6}${PY_S}+${PY_NOT_S}`, 'u')
const CODE_FENCE_RE = new RegExp(`^${PY_S}*(?:\`\`\`|~~~)`, 'u')
const TABLE_SEP_RE = new RegExp(`^${PY_S}*\\|?[${PY_WS}:|-]*\\|[${PY_WS}:|-]*$`, 'u')
const URL_ONLY_RE = new RegExp(`^${PY_S}*<?(?:https?://|www\\.)${PY_NOT_S}+>?${PY_S}*$`, 'iu')
const HTML_ONLY_RE = new RegExp(`^${PY_S}*<[^>]+>${PY_S}*$`, 'u')

/** Python's `[^\W_]`: any letter or digit, excluding underscore. */
const HAS_ALNUM_RE = /[\p{L}\p{N}]/u

/** "Encore:", "Main set:", "Disc 2:" — a short label introducing a section. */
const SECTION_LABEL_RE = new RegExp(`^${PY_S}*${PY_NOT_S}[^:]{0,40}:${PY_S}*$`, 'u')

/** A line with more words than this is prose, not a track entry. */
export const PROSE_WORD_LIMIT = 12

/** A sentence break: terminal punctuation followed by the start of a new sentence. */
const SENTENCE_RE = new RegExp(`([\\p{L}\\p{N}_']+)?[.!?]+[)"'”]?${PY_S}+(?=["“\\p{Lu}0-9])`, 'gu')

/**
 * Abbreviations whose period is not a sentence break.
 *
 * Without these, "Mr. Brightside" and "Vol. 2" read as prose and never reach a parser.
 */
const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'st',
  'jr',
  'sr',
  'prof',
  'rev',
  'gen',
  'sgt',
  'vs',
  'feat',
  'ft',
  'no',
  'vol',
  'pt',
  'op',
  'ch',
  'fig',
  'inc',
  'ltd',
  'co',
  'corp',
  'etc',
  'ca',
  'approx',
  'orig',
  'rec',
])

/** Below this many words a line is short enough to be a bare title. */
export const BARE_TITLE_WORD_LIMIT = 10
/** A document needs at least this many content lines before list-shape is meaningful. */
export const MIN_LIST_LINES = 3
/** Above this share of prose lines, a document is an article, not a list. */
export const MAX_PROSE_FRACTION = 0.3
/** Word count above which a sentence break is taken as evidence of prose. */
const SENTENCE_MIN_WORDS = 3

const STRIP_RE = new RegExp(`^${PY_S}+|${PY_S}+$`, 'gu')
const SPLIT_RE = new RegExp(`${PY_S}+`, 'u')

/** Python's `str.strip()`. */
const strip = (value: string): string => value.replace(STRIP_RE, '')

/** Python's `str.split()` with no argument: split on runs of whitespace, drop empties. */
const words = (value: string): string[] =>
  strip(value)
    .split(SPLIT_RE)
    .filter(w => w !== '')

/** Report whether a line is structural markup rather than content. */
export function looksLikeNoise(text: string): boolean {
  if (!strip(text)) return true
  if (!HAS_ALNUM_RE.test(text)) return true
  return (
    RULE_RE.test(text) ||
    MD_HEADING_RE.test(text) ||
    CODE_FENCE_RE.test(text) ||
    TABLE_SEP_RE.test(text) ||
    URL_ONLY_RE.test(text) ||
    HTML_ONLY_RE.test(text) ||
    SECTION_LABEL_RE.test(text)
  )
}

/**
 * Report whether `text` contains a real sentence boundary.
 *
 * Abbreviations and single-letter initials ("R.E.M.") are excluded, since those periods
 * are part of names that routinely appear in track titles.
 */
function hasSentenceBreak(text: string): boolean {
  // A fresh regex per call: `SENTENCE_RE` carries the `g` flag, and a shared global
  // regex keeps `lastIndex` between calls, so the second caller starts mid-string. That
  // is a JavaScript-only hazard with no counterpart in Python's `finditer`.
  const pattern = new RegExp(SENTENCE_RE.source, SENTENCE_RE.flags)
  for (const match of text.matchAll(pattern)) {
    const word = match[1]
    if (word === undefined) return true
    const cleaned = word.toLowerCase().replace(/'+$/u, '')
    if (cleaned.length > 1 && !ABBREVIATIONS.has(cleaned)) return true
  }
  return false
}

/**
 * Report whether a line reads as a sentence rather than a list entry.
 *
 * Prose is not noise: it may contain songs, so it goes to the LLM residual pass. The
 * point of this check is only to stop the bare-title parser from claiming it.
 */
export function looksLikeProse(text: string): boolean {
  const stripped = strip(text)
  if (!stripped) return false
  const parts = words(stripped)
  if (parts.length > PROSE_WORD_LIMIT) return true
  return parts.length > SENTENCE_MIN_WORDS && hasSentenceBreak(stripped)
}

/** The median of a list of numbers, matching Python's `statistics.median`. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  // Even-length lists average the two middle values, as Python does — and the average
  // is a float, which matters because the caller compares it with `>`.
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/**
 * Report whether a document looks like a list of entries rather than an article.
 *
 * Gates the bare-title parser. On a genuine list ("Bohemian Rhapsody" on its own line) a
 * separator-less line is a track; in an article the same line is a fragment, and
 * claiming it would manufacture songs the author never listed.
 */
export function isListShaped(lines: readonly Line[]): boolean {
  const content = lines.filter(line => !looksLikeNoise(line.text)).map(line => strip(line.text))
  if (content.length < MIN_LIST_LINES) return false
  const wordCounts = content.map(text => words(text).length)
  if (median(wordCounts) > BARE_TITLE_WORD_LIMIT) return false
  const proseLines = content.filter(text => looksLikeProse(text)).length
  return proseLines / content.length < MAX_PROSE_FRACTION
}
