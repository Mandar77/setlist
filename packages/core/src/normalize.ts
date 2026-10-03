/**
 * Text normalization: document canonicalization, qualifier stripping, dedup keys.
 *
 * Two distinct kinds of normalization live here and must not be confused:
 *
 * 1. **Document normalization** (`normalizeDocument`) produces the canonical text that
 *    every `Span` indexes into. It is applied exactly once, at ingest.
 * 2. **Key folding** (`fold`, `dedupeKey`) produces lossy comparison keys. It is never
 *    written back into user-visible fields and never affects span offsets.
 *
 * ## Porting note: three ways Python and JavaScript regexes disagree
 *
 * ADR-001 calls Unicode behaviour "the most likely source of a real divergence". In this
 * module it is not a risk, it is a certainty, and all three differences were found by
 * the differential test rather than by reading:
 *
 * 1. **`\w` is Unicode-aware in Python and ASCII-only in JavaScript.** Python's
 *    `[^\w\s]` keeps Cyrillic and Greek; the ASCII form strips them as punctuation, so
 *    `fold("Печаль")` returns "" and every Russian title collapses into one dedup key.
 * 2. **`\b` has the same problem** and cannot be fixed by a flag, so word boundaries are
 *    written as explicit non-letter lookarounds.
 * 3. **`\s` is a different set in each language.** Enumerated rather than assumed:
 *    Python has U+001C–U+001F and U+0085 that JavaScript lacks; JavaScript has U+FEFF
 *    that Python lacks. The last one bites — a zero-width no-break space inside a title
 *    is whitespace to JavaScript, so `normalizeArtist` turned "Seven Sea<U+FEFF>s of
 *    Rhye" into "Seven Sea s of Rhye" while the oracle left it alone.
 *
 * Nothing here is correct by inspection. `test/differential.test.ts` is the proof.
 */

import anyAscii from 'any-ascii'

import { Qualifier } from './enums.js'

/**
 * Zero-width and bidi-control characters.
 *
 * Invisible, they survive NFKC, and they are a documented prompt-injection and
 * homoglyph vector — the payload test matrix (PRD §10) fuzzes them explicitly.
 *
 * Written as code points rather than as character literals, which is not a style
 * preference. The first draft used escape sequences; Prettier rewrote every one into the
 * character it stands for, leaving a source file whose most important constant was
 * twenty-one invisible characters rendering as an array of empty strings — in the module
 * whose entire job is handling invisible characters. `String.fromCodePoint` of a number
 * cannot be rewritten that way, and the number is readable.
 */
const INVISIBLE = new Set(
  [
    0x00ad, // soft hyphen
    0x200b, // ZWSP
    0x200c, // ZWNJ
    0x200d, // ZWJ
    0x200e, // LRM
    0x200f, // RLM
    0x2060, // word joiner
    0x2061,
    0x2062,
    0x2063,
    0x2064, // invisible operators
    0x202a,
    0x202b,
    0x202c,
    0x202d,
    0x202e, // bidi embedding / override
    0x2066,
    0x2067,
    0x2068,
    0x2069, // bidi isolates
    0xfeff, // BOM / ZWNBSP
  ].map(cp => String.fromCodePoint(cp)),
)

/**
 * Python's `\s`, written out. See the porting note above for why it is not `\s`.
 *
 * Exported as `PY_S` because the parser modules build their own regexes from the same
 * Python sources and need the same class. A second definition there would be a second
 * chance to get U+FEFF wrong.
 */
const WS =
  '\\t\\n\\v\\f\\r\\u001c-\\u001f \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const S = `[${WS}]`

/** Python's whitespace class, for the parser modules: the class, its negation, its body. */
export const PY_WS = WS
export const PY_S = S
export const PY_NOT_S = `[^${WS}]`

/** A word boundary that behaves the way Python's `\b` does on Unicode text. */
const B = '(?<![\\p{L}\\p{N}_])'
const BE = '(?![\\p{L}\\p{N}_])'

/** Python's `\w`, which JavaScript spells `[A-Za-z0-9_]` and means differently. */
const W = '[\\p{L}\\p{N}_]'

const ISRC_STRIP_RE = new RegExp(`[${WS}-]+`, 'gu')
export const ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/u

const DURATION_RE = /^(?:(\d{1,2}):)?(\d{1,3}):([0-5]\d)$/u

/** Trailing "(...)" or "[...]" with no nested brackets. */
const TRAILING_BRACKET_RE = new RegExp(`${S}*[([]${S}*([^()\\[\\]]*?)${S}*[)\\]]${S}*$`, 'u')

/**
 * Trailing " - annotation" (en/em dash included).
 *
 * Only consumed when the tail classifies as a known annotation, so ordinary hyphenated
 * titles survive intact.
 */
const DASHES = '\\-\\u2010-\\u2015\\u2212'
const TRAILING_DASH_RE = new RegExp(`${S}+[${DASHES}]${S}+([^${DASHES}]+?)${S}*$`, 'u')

const FEAT_RE = new RegExp(`^(?:feat\\.?|ft\\.?|featuring|w\\.?/)${S}+(.+)$`, 'iu')
const INLINE_FEAT_RE = new RegExp(`${S}+(?:feat\\.|ft\\.|featuring)${S}+(.+)$`, 'iu')

/** Artist-list separators. `\b` in the oracle; explicit lookarounds here. */
const ARTIST_SPLIT_RE = new RegExp(
  `${S}*(?:,|&|${B}x${BE}|${B}vs\\.?${BE}|${B}and${BE}|\\+)${S}*`,
  'giu',
)

/** Order matters only for readability; every pattern is tested against each annotation. */
const QUALIFIER_PATTERNS: readonly (readonly [RegExp, Qualifier])[] = [
  [new RegExp(`${B}live${BE}`, 'iu'), Qualifier.LIVE],
  [new RegExp(`${B}remaster(?:ed)?${BE}`, 'iu'), Qualifier.REMASTER],
  [new RegExp(`${B}re-?mix(?:ed|es)?${BE}|${B}${W}+${S}+mix${BE}`, 'iu'), Qualifier.REMIX],
  [new RegExp(`${B}acoustic${BE}|${B}unplugged${BE}`, 'iu'), Qualifier.ACOUSTIC],
  [new RegExp(`${B}instrumental${BE}`, 'iu'), Qualifier.INSTRUMENTAL],
  [new RegExp(`${B}radio${S}+(?:edit|mix|version)${BE}`, 'iu'), Qualifier.RADIO_EDIT],
  [new RegExp(`${B}extended${BE}`, 'iu'), Qualifier.EXTENDED],
  [new RegExp(`${B}demo${BE}`, 'iu'), Qualifier.DEMO],
  [new RegExp(`${B}cover${BE}`, 'iu'), Qualifier.COVER],
  [new RegExp(`${B}karaoke${BE}`, 'iu'), Qualifier.KARAOKE],
]

/**
 * "Extended Mix" / "Original Mix" are the label's own master, not a third-party remix.
 * The generic "<word> Mix" pattern would otherwise tag them REMIX and send the matcher
 * hunting for a remix that does not exist.
 */
const NON_REMIX_MIX_RE = new RegExp(
  `^(?:extended|original|album|radio|single|main|final|full)${S}+mix$`,
  'iu',
)

/**
 * Annotations that are version markers but carry no qualifier of their own; peeling them
 * still improves the match key (e.g. "(Original Mix)", "(Single Version)").
 */
const BARE_VERSION_RE = new RegExp(
  '^(?:original|single|album|deluxe|explicit|clean|bonus|stereo|mono)' +
    `(?:${S}+(?:mix|version|edit|track|master|cut))?$`,
  'iu',
)

/** Python's `[^\w\s]`: everything that is not a letter, number, underscore or space. */
const PUNCT_RE = new RegExp(`[^\\p{L}\\p{N}_${WS}]+`, 'gu')
const WS_RE = new RegExp(`${S}+`, 'gu')
const STRIP_RE = new RegExp(`^${S}+|${S}+$`, 'gu')
const RSTRIP_RE = new RegExp(`${S}+$`, 'u')
const LEADING_BY_RE = new RegExp(`^by${S}+`, 'iu')

/** Unicode category Cc — the C0 and C1 control characters. */
const CC_RE = /^\p{Cc}$/u

/** Python's `str.strip(chars)`: trim any of `chars` from both ends. */
function stripChars(value: string, chars: string): string {
  const drop = new Set(chars)
  let start = 0
  let end = value.length
  while (start < end && drop.has(value[start]!)) start += 1
  while (end > start && drop.has(value[end - 1]!)) end -= 1
  return value.slice(start, end)
}

/** Python's `str.strip()`. */
function strip(value: string): string {
  return value.replace(STRIP_RE, '')
}

/**
 * Python's `str.strip()`, exported for the models.
 *
 * Not `String.prototype.trim()`, which uses JavaScript's whitespace set: it would strip
 * a trailing U+FEFF that Python keeps, and keep a U+0085 that Python strips. The models
 * apply this to every string field to reproduce pydantic's `str_strip_whitespace`, so
 * the difference would land on every title in the corpus.
 */
export function pyStrip(value: string): string {
  return strip(value)
}

/** Python's `str.rstrip()`. */
function rstrip(value: string): string {
  return value.replace(RSTRIP_RE, '')
}

/**
 * Canonicalize a raw input document into span coordinate space.
 *
 * Applies Unicode NFKC, normalizes line endings to `\n`, removes invisible formatting
 * characters, and strips control characters other than tab and newline. Length is
 * **not** preserved — see the span contract in the package README.
 */
export function normalizeDocument(raw: string): string {
  const text = raw.replaceAll('\r\n', '\n').replaceAll('\r', '\n').normalize('NFKC')
  let out = ''
  // Iterated by code point, as Python iterates by character: a surrogate pair must not
  // be split, and `\p{Cc}` must be tested against a whole code point.
  for (const ch of text) {
    if (INVISIBLE.has(ch)) continue
    if (ch !== '\n' && ch !== '\t' && CC_RE.test(ch)) continue
    out += ch
  }
  return out
}

/**
 * Reduce a string to a lossy comparison key.
 *
 * Transliterates to ASCII, lowercases, drops punctuation, and collapses whitespace.
 * Used for dedup keys and match scoring — never for display.
 *
 * NFKD before transliteration, matching the oracle: anyascii ships the same tables in
 * both languages, but a precomposed "é" and a decomposed one are different inputs to it.
 */
export function fold(value: string): string {
  const asciiForm = anyAscii(value.normalize('NFKD'))
  return strip(asciiForm.toLowerCase().replace(PUNCT_RE, ' ').replace(WS_RE, ' '))
}

/** The folded, whitespace-delimited tokens of `value`. */
export function tokens(value: string): string[] {
  const folded = fold(value)
  return folded ? folded.split(' ') : []
}

/** Split a featured-artist blob such as `"Doja Cat, SZA & Rosalia"` into names. */
export function splitFeatured(value: string): string[] {
  return value
    .split(ARTIST_SPLIT_RE)
    .map(part => stripChars(part, ' .;'))
    .filter(part => part !== '')
}

interface Classified {
  readonly qualifiers: Qualifier[]
  readonly featured: string[]
  readonly recognized: boolean
}

/**
 * Classify a peeled annotation.
 *
 * `recognized` is `false` for annotations that belong to the real title ("(Interlude)",
 * "(Part 2)"), which stops any further peeling.
 */
function classify(annotation: string): Classified {
  const feat = FEAT_RE.exec(annotation)
  if (feat) return { qualifiers: [], featured: splitFeatured(feat[1]!), recognized: true }

  const found = new Set<Qualifier>()
  for (const [pattern, qualifier] of QUALIFIER_PATTERNS) {
    if (pattern.test(annotation)) found.add(qualifier)
  }
  if (found.has(Qualifier.REMIX) && NON_REMIX_MIX_RE.test(annotation)) {
    found.delete(Qualifier.REMIX)
  }
  if (found.size > 0) return { qualifiers: [...found], featured: [], recognized: true }
  if (BARE_VERSION_RE.test(annotation)) return { qualifiers: [], featured: [], recognized: true }
  return { qualifiers: [], featured: [], recognized: false }
}

export interface StrippedTitle {
  readonly base: string
  readonly qualifiers: Qualifier[]
  readonly featured: string[]
  /**
   * The most specific version annotation, verbatim (e.g. "Eric Prydz Remix"), because
   * matching scores it against candidate titles. `null` when none was found.
   */
  readonly versionLabel: string | null
}

/** Peel version markers and featured artists off a track title. */
export function stripQualifiers(title: string): StrippedTitle {
  let base = strip(title)
  const qualifiers = new Set<Qualifier>()
  const featured: string[] = []
  let versionLabel: string | null = null

  while (base) {
    let consumed = false
    for (const pattern of [TRAILING_BRACKET_RE, TRAILING_DASH_RE]) {
      const match = pattern.exec(base)
      if (!match) continue
      const annotation = strip(match[1]!)
      if (!annotation) {
        base = rstrip(base.slice(0, match.index))
        consumed = true
        break
      }
      const { qualifiers: found, featured: who, recognized } = classify(annotation)
      if (!recognized) return finish(base, qualifiers, featured, versionLabel)
      for (const q of found) qualifiers.add(q)
      featured.push(...who)
      if (found.length > 0 && versionLabel === null) versionLabel = annotation
      base = rstrip(base.slice(0, match.index))
      consumed = true
      break
    }
    if (!consumed) break
  }

  const inline = INLINE_FEAT_RE.exec(base)
  if (inline) {
    featured.push(...splitFeatured(inline[1]!))
    base = rstrip(base.slice(0, inline.index))
  }

  return finish(base, qualifiers, featured, versionLabel)
}

/** Assemble the `stripQualifiers` return value, de-duplicating featured artists. */
function finish(
  base: string,
  qualifiers: Set<Qualifier>,
  featured: string[],
  versionLabel: string | null,
): StrippedTitle {
  // `dict.setdefault` keyed on the folded name: the first spelling of a repeated credit
  // wins and insertion order is preserved. The oracle relies on both.
  const seen = new Map<string, string>()
  for (const name of featured) {
    const key = fold(name)
    if (!seen.has(key)) seen.set(key, name)
  }
  return {
    base: stripChars(base, ' -–—'),
    qualifiers: [...qualifiers],
    featured: [...seen.values()],
    versionLabel,
  }
}

/** Trim list punctuation and a leading `by` from an artist string. */
export function normalizeArtist(artist: string): string {
  let cleaned = stripChars(strip(artist), '-–—,;: \t')
  cleaned = cleaned.replace(LEADING_BY_RE, '')
  return strip(cleaned.replace(WS_RE, ' '))
}

/**
 * Separate a primary artist from featured credits folded into the same string.
 *
 * `"Calvin Harris feat. Dua Lipa"` becomes `["Calvin Harris", ["Dua Lipa"]]`.
 * Collaboration joiners (`&`, `x`, `and`) are left alone: they are part of the primary
 * credit as providers spell it, and splitting them would hurt matching.
 */
export function splitArtistCredits(artist: string): [string, string[]] {
  const cleaned = normalizeArtist(artist)
  const match = INLINE_FEAT_RE.exec(cleaned)
  if (!match) {
    const bracketed = TRAILING_BRACKET_RE.exec(cleaned)
    if (bracketed) {
      const feat = FEAT_RE.exec(strip(bracketed[1]!))
      if (feat) {
        return [normalizeArtist(cleaned.slice(0, bracketed.index)), splitFeatured(feat[1]!)]
      }
    }
    return [cleaned, []]
  }
  return [normalizeArtist(cleaned.slice(0, match.index)), splitFeatured(match[1]!)]
}

/**
 * Report whether `text` ends in a recognized version or credit annotation.
 *
 * Used to decide which side of an "A - B" line is the title: version markers attach to
 * titles, not to artist names.
 */
export function hasVersionAnnotation(text: string): boolean {
  const { base, qualifiers, featured, versionLabel } = stripQualifiers(text)
  return (qualifiers.length > 0 || featured.length > 0 || versionLabel !== null) && Boolean(base)
}

/**
 * Uppercase and validate an ISRC, returning `null` if it is not well formed.
 *
 * ISRCs are the canonical cross-platform key (PRD §7.10.1), so a malformed one must
 * fail closed rather than reach a provider search.
 */
export function normalizeIsrc(value: string): string | null {
  const candidate = value.replace(ISRC_STRIP_RE, '').toUpperCase()
  return ISRC_RE.test(candidate) ? candidate : null
}

/** Parse `mm:ss` or `h:mm:ss` into seconds, or `null` if unparseable. */
export function parseDuration(value: string): number | null {
  const match = DURATION_RE.exec(strip(value))
  if (!match) return null
  const hours = Number(match[1] ?? 0)
  return hours * 3600 + Number(match[2]) * 60 + Number(match[3])
}

/**
 * Build the collapse key for FR-004 deduplication.
 *
 * Qualifiers participate in the key on purpose: a studio cut and its live version are
 * different recordings and must not collapse into one playlist entry.
 */
export function dedupeKey(
  title: string,
  artist: string | null,
  qualifiers: Iterable<Qualifier>,
): string {
  return [fold(title), fold(artist ?? ''), [...new Set(qualifiers)].sort().join(',')].join('|')
}
