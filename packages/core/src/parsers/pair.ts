/**
 * Pattern parsers that split a line into (artist, title) — FR-002.
 *
 * Each parser receives a line that affix stripping has already reduced to its payload,
 * and returns a `LineMatch` or passes. They are tried in descending order of how
 * self-labelling the pattern is: a quoted title states which side it is, `by` states it
 * in words, and a bare dash only implies it by convention.
 */

import { lineSpan, makeHints, type Line } from '../models.js'
import {
  hasVersionAnnotation,
  normalizeArtist,
  PY_S,
  splitArtistCredits,
  stripQualifiers,
} from '../normalize.js'
import type { LineMatch } from './base.js'
import { BARE_TITLE_WORD_LIMIT, looksLikeProse } from './noise.js'

/**
 * Double quotes only. Apostrophes are far too common inside real titles
 * ("Sweet Child o' Mine") to treat as delimiters.
 */
const OPEN = '"“«'
const CLOSE = '"”»'
const Q = `[${OPEN}]`
const QC = `[${CLOSE}]`

const QUOTED_RIGHT_RE = new RegExp(
  `^(.+?)${PY_S}*[-:–—]${PY_S}*${Q}([^${CLOSE}]+)${QC}${PY_S}*$`,
  'u',
)
const QUOTED_LEFT_RE = new RegExp(
  `^${Q}([^${CLOSE}]+)${QC}${PY_S}*(?:[-–—]|(?<![\\p{L}\\p{N}_])by(?![\\p{L}\\p{N}_]))${PY_S}*(.+)$`,
  'iu',
)
const BY_RE = new RegExp(`^(.+?)${PY_S}+by${PY_S}+(.+)$`, 'iu')

/**
 * " - " needs surrounding space so hyphenated names survive; en/em dashes do not,
 * because they effectively never appear inside an artist or title token.
 */
const SEPARATOR_RE = new RegExp(`${PY_S}+[-~|/•·]${PY_S}+|${PY_S}*[–—―]${PY_S}*`, 'u')
const TAB_RE = /^([^\t]+?)\t+([^\t]+)$/u

/**
 * An artist credit longer than this is a sentence clause, not a name. Six covers
 * "Nick Cave and the Bad Seeds" and "Crosby, Stills, Nash & Young".
 */
const MAX_ARTIST_WORDS = 6
/** A title longer than this is a mis-split rather than a track name. */
const MAX_TITLE_WORDS = 12

/**
 * A credit starting with one of these is a noun phrase, not an artist. Bands do begin
 * with "The", which is why that is absent.
 */
const DETERMINERS = new Set([
  'a',
  'an',
  'my',
  'our',
  'your',
  'their',
  'his',
  'her',
  'its',
  'this',
  'that',
  'these',
  'those',
  'some',
  'any',
  'every',
])

/**
 * Participles that turn "X by Y" into a credit rather than a song.
 *
 * Checked against the word immediately before "by", which is what distinguishes
 * "Our picks, compiled by the editors" from "Midnight City by M83".
 */
const CREDIT_PARTICIPLES = new Set([
  'written',
  'produced',
  'mixed',
  'mastered',
  'composed',
  'arranged',
  'compiled',
  'curated',
  'edited',
  'published',
  'released',
  'uploaded',
  'posted',
  'submitted',
  'recorded',
  'directed',
  'assembled',
  'selected',
  'chosen',
  'picked',
  'ranked',
  'presented',
  'sourced',
  'sponsored',
  'inspired',
  'brought',
  'made',
  'created',
  'reviewed',
])

/** Production-credit lines look exactly like "Title by Artist" but name no song. */
const CREDIT_PREFIX_RE = new RegExp(
  '^(?:written|produced|mixed|mastered|composed|arranged|compiled|curated|edited' +
    '|published|released|uploaded|posted|submitted|recorded|directed|photo|photos' +
    '|images?|artwork|inspired)(?![\\p{L}\\p{N}_])',
  'iu',
)

const INLINE_BY_RE = /(?<![\p{L}\p{N}_])by(?![\p{L}\p{N}_])/iu

const STRIP_RE = new RegExp(`^${PY_S}+|${PY_S}+$`, 'gu')
const SPLIT_RE = new RegExp(`${PY_S}+`, 'u')

const strip = (value: string): string => value.replace(STRIP_RE, '')
const words = (value: string): string[] =>
  strip(value)
    .split(SPLIT_RE)
    .filter(w => w !== '')

/** Python's `str.strip(chars)`. */
function stripChars(value: string, chars: string): string {
  const drop = new Set(chars)
  let start = 0
  let end = value.length
  while (start < end && drop.has(value[start]!)) start += 1
  while (end > start && drop.has(value[end - 1]!)) end -= 1
  return value.slice(start, end)
}

/** Normalize a raw (title, artist) split into a `LineMatch`, or reject it. */
function build(
  line: Line,
  titleRaw: string,
  artistRaw: string | null,
  parser: string,
  ambiguousDirection = false,
): LineMatch | null {
  const { base: title, qualifiers, featured, versionLabel } = stripQualifiers(titleRaw)
  if (!title || words(title).length > MAX_TITLE_WORDS) return null

  let artist: string | null = null
  let credited: string[] = []
  if (artistRaw) {
    const [primary, feat] = splitArtistCredits(artistRaw)
    artist = primary || null
    credited = feat
  }

  const span = lineSpan(line)
  if (span === null) return null

  // `dict.fromkeys` in the oracle: de-duplicate while preserving first-seen order.
  const merged = [...new Set([...featured, ...credited])]

  return {
    title,
    artist,
    span,
    parser,
    hints: makeHints({ featuredArtists: merged, qualifiers, versionLabel }),
    ambiguousDirection,
    structured: false,
  }
}

/**
 * Parse lines where quotation marks identify the title.
 *
 * Handles both `Artist - "Title"` and `"Title" - Artist` / `"Title" by Artist`.
 */
export function parseQuoted(line: Line): LineMatch | null {
  const right = QUOTED_RIGHT_RE.exec(line.text)
  if (right) return build(line, right[2]!, right[1]!, 'quoted')
  const left = QUOTED_LEFT_RE.exec(line.text)
  if (left) return build(line, left[1]!, left[2]!, 'quoted')
  return null
}

/**
 * Parse `Title by Artist`.
 *
 * The artist side is length-capped: without that, a sentence such as "This list was
 * compiled by our editors" parses as a song.
 */
export function parseBy(line: Line): LineMatch | null {
  if (CREDIT_PREFIX_RE.test(line.text)) return null
  const match = BY_RE.exec(line.text)
  if (!match) return null

  const titleSide = strip(match[1]!)
  const trailing = words(titleSide)
  const last = trailing.at(-1)
  if (last !== undefined && CREDIT_PARTICIPLES.has(stripChars(last, ',;:').toLowerCase())) {
    return null
  }

  const artist = normalizeArtist(match[2]!)
  if (!artist || words(artist).length > MAX_ARTIST_WORDS) return null
  if (DETERMINERS.has(words(artist)[0]!.toLowerCase())) return null
  if (INLINE_BY_RE.test(artist)) return null
  return build(line, match[1]!, artist, 'by')
}

/**
 * Decide which side of a separator is the artist.
 *
 * The default is artist-first, the convention PRD §5 FR-002 names ("Artist - Title"); a
 * version annotation on one side overrides it, since those attach to titles.
 */
function direction(left: string, right: string): [string, string, boolean] {
  const leftTitleish = hasVersionAnnotation(left)
  const rightTitleish = hasVersionAnnotation(right)
  if (leftTitleish && !rightTitleish) return [right, left, false]
  return [left, right, leftTitleish && rightTitleish]
}

/**
 * Split on the first separator only.
 *
 * Python's `re.split(pattern, text, maxsplit=1)` has no direct JavaScript equivalent:
 * `String.split` with a limit truncates the result rather than stopping the split, so
 * "A - B - C" would come back as ["A", "B"] and silently lose " - C" from the title.
 */
function splitOnce(text: string): [string, string] | null {
  const match = SEPARATOR_RE.exec(text)
  if (!match) return null
  return [text.slice(0, match.index), text.slice(match.index + match[0].length)]
}

/**
 * The two sides of a dash line, in the order they appear in the text.
 *
 * `parseDash` returns a title and an artist, which is the *interpreted* result — by then
 * `direction()` has already decided which side was which. ADR-002's rung 2 needs the
 * uninterpreted left and right, because the statistic it computes is positional: the
 * column that repeats is the artist, whichever column that turns out to be.
 *
 * Returns null for anything that is not a dash pair, so callers can map over every match
 * without filtering first.
 */
export function dashSides(line: Line): [string, string] | null {
  const parts = splitOnce(line.text)
  if (parts === null) return null
  const left = strip(parts[0])
  const right = strip(parts[1])
  return left && right ? [left, right] : null
}

/** Parse `Artist - Title` and its dash/pipe/bullet separator variants. */
export function parseDash(line: Line): LineMatch | null {
  const parts = splitOnce(line.text)
  if (parts === null) return null
  const left = strip(parts[0])
  const right = strip(parts[1])
  if (!left || !right) return null
  const [artist, title, ambiguous] = direction(left, right)
  // An artist credit is a name, not a clause. This is the main defence against a prose
  // sentence that happens to contain " - " parsing as a track.
  if (words(artist).length > MAX_ARTIST_WORDS) return null
  return build(line, title, artist, 'dash', ambiguous)
}

/**
 * Parse a tab-separated pair.
 *
 * A stray tab carries no convention about column order the way a dash does, so the
 * result is always flagged ambiguous and lands in review. Whole-document TSV goes
 * through the table parser instead, which can read a header row.
 */
export function parseTab(line: Line): LineMatch | null {
  const match = TAB_RE.exec(line.text)
  if (!match) return null
  const left = strip(match[1]!)
  const right = strip(match[2]!)
  if (!left || !right) return null
  return build(line, right, left, 'tab', true)
}

/**
 * Parse a separator-less line as a title with no artist.
 *
 * Only safe on documents that `noise.isListShaped` has already judged to be lists; the
 * registry enforces that gate. Even then the result is low confidence, because a title
 * alone is a weak query against any provider catalog.
 */
export function parseBare(line: Line): LineMatch | null {
  const text = strip(line.text)
  if (!text || looksLikeProse(text) || words(text).length > BARE_TITLE_WORD_LIMIT) return null
  return build(line, text, null, 'bare')
}
