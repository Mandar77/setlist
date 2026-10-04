/**
 * The fonts the corpus may draw with, and the two questions that have to be answered
 * before a row is allowed into an image.
 *
 * ## "OFL or Apache only; licences recorded"
 *
 * Each `@fontsource/*` package ships a `metadata.json` carrying the upstream licence
 * type and its attribution line. That is read here rather than written down by hand, so
 * "licences recorded" is a fact about the installed packages instead of a claim in a
 * README that goes stale the first time a font is swapped. A font whose metadata reports
 * anything outside {@link ALLOWED_LICENCES} is refused — see `fonts.test.ts`, which
 * checks the refusal as well as the acceptance.
 *
 * ## Coverage, and why it is not optional
 *
 * CSS cannot switch font fallback off. Hand a Chromium page a Japanese title in Rock
 * Salt — a Latin-only handwriting face — and it does not draw tofu; it silently falls
 * back to whatever system font has the glyph. Two things break at once: the image no
 * longer shows the handwriting the manifest says it shows, and the glyphs that did get
 * drawn came from a system font under no licence this project vetted.
 *
 * So coverage is decided here, before rendering, from the font's own published
 * `unicode.json`. A row is only offered to a font that covers every codepoint in it, and
 * only the subset files a document actually needs are embedded. Rows no font covers are
 * counted and reported rather than dropped in silence — {@link coverageReport} is what
 * keeps "the corpus is Latin-heavy because the handwriting faces are" an observable
 * number instead of a surprise.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/**
 * The only licences a font in this corpus may carry.
 *
 * Both permit redistribution of the rendered output and of the font itself, which is
 * what generating images in CI and publishing this repository need. Anything else — a
 * free-for-personal-use face, an unstated licence — is refused rather than reviewed
 * case by case, because "is this one fine?" is a question nobody should have to answer
 * while adding a font.
 */
export const ALLOWED_LICENCES: ReadonlySet<string> = new Set(['OFL-1.1', 'Apache-2.0'])

/** How a face is used, which is also how fontsource categorises it. */
export type FontCategory = 'handwriting' | 'sans-serif' | 'serif' | 'monospace'

export interface FontSubset {
  readonly name: string
  /** Every codepoint the subset's file contains, as [start, end] pairs. */
  readonly ranges: readonly (readonly [number, number])[]
  /**
   * The descriptor verbatim, for the `@font-face` rule.
   *
   * Kept alongside the parsed form rather than re-serialized from it: a subset file only
   * holds its own glyphs, so the `unicode-range` Chromium uses to choose between the
   * faces must be the one the font was actually cut to. Round-tripping it through this
   * module's parser would make a parser bug into a rendering bug.
   */
  readonly range: string
}

export interface Font {
  /** The npm package, e.g. `@fontsource/caveat`. */
  readonly pkg: string
  /** The CSS family name, e.g. `Caveat`. */
  readonly family: string
  readonly category: FontCategory
  readonly licence: string
  readonly attribution: string
  readonly subsets: readonly FontSubset[]
}

/** What fontsource's `metadata.json` carries, narrowed to the fields used here. */
export interface FontsourceMetadata {
  readonly id: string
  readonly family: string
  readonly category: string
  readonly subsets: readonly string[]
  readonly weights: readonly number[]
  readonly license: { readonly type: string; readonly attribution: string }
}

/**
 * Parse one `unicode-range` descriptor into codepoint ranges.
 *
 * The grammar is CSS's: `U+0301`, `U+0400-045F`, and the wildcard form `U+30??`. All
 * three appear in fontsource's files, and a parser that handled only the first two would
 * silently under-report coverage for the faces that use wildcards — which fails the safe
 * way for licensing but would quietly shrink the corpus, so it is handled rather than
 * rejected.
 */
export function parseUnicodeRange(spec: string): (readonly [number, number])[] {
  const ranges: (readonly [number, number])[] = []
  for (const raw of spec.split(',')) {
    const token = raw.trim()
    if (token === '') continue
    const body = /^u\+(.+)$/i.exec(token)?.[1]
    if (body === undefined) throw new SyntaxError(`not a unicode-range token: ${token}`)

    const dash = body.indexOf('-')
    if (dash !== -1) {
      const start = Number.parseInt(body.slice(0, dash), 16)
      const end = Number.parseInt(body.slice(dash + 1), 16)
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        throw new SyntaxError(`not a unicode-range token: ${token}`)
      }
      ranges.push([start, end])
      continue
    }

    if (body.includes('?')) {
      const start = Number.parseInt(body.replaceAll('?', '0'), 16)
      const end = Number.parseInt(body.replaceAll('?', 'F'), 16)
      ranges.push([start, end])
      continue
    }

    const only = Number.parseInt(body, 16)
    if (!Number.isFinite(only)) throw new SyntaxError(`not a unicode-range token: ${token}`)
    ranges.push([only, only])
  }
  if (ranges.length === 0) throw new SyntaxError(`empty unicode-range: ${spec}`)
  return ranges
}

/**
 * Something shaped like an address, deliberately greedy about what counts as one.
 *
 * Over-matching here costs a slightly mangled copyright line. Under-matching puts a real
 * person's address in a public repository.
 */
const EMAIL_RE = /[^\s<>()[\]",;:]+@[^\s<>()[\]",;:]+\.[A-Za-z]{2,}/g

/**
 * Strip contact addresses out of an upstream copyright line.
 *
 * OFL and Apache headers routinely carry the designer's address, in the shape
 * "Copyright (c) 2010, A Designer (their-site.example their-name at gmail)". Recording
 * that verbatim would republish a private individual's address in a public repository,
 * which ADR-005 forbids and `tools/check_no_secrets.py` catches. It caught this — three
 * of the fourteen fonts here carry one, and the example above is spelled out of band for
 * the same reason.
 *
 * Redacting rather than allowlisting the finding is the only version of this that keeps
 * the gate: what the licence requires is the copyright holder's name, and that survives.
 * Their inbox was never part of the attribution anyone needs.
 */
export function redactEmails(text: string): string {
  return text.replace(EMAIL_RE, '[email removed]')
}

function categoryOf(raw: string, pkg: string): FontCategory {
  switch (raw) {
    case 'handwriting':
    case 'sans-serif':
    case 'serif':
    case 'monospace':
      return raw
    // Positively matched, with the miss handled explicitly: a fontsource category this
    // generator has never seen is a font nobody decided how to use, not a sans-serif.
    default:
      throw new Error(`${pkg}: unsupported fontsource category "${raw}"`)
  }
}

/**
 * Build a `Font` from metadata already in hand, refusing a licence outside the allowlist.
 *
 * Split from {@link loadFont} so the refusal is testable. A licence gate that can only be
 * exercised against the packages that are installed — all of which pass — is a gate
 * nobody has ever seen work.
 */
export function fontFrom(
  pkg: string,
  metadata: FontsourceMetadata,
  unicode: Record<string, string>,
): Font {
  const licence = metadata.license.type
  if (!ALLOWED_LICENCES.has(licence)) {
    throw new Error(
      `${pkg}: licence "${licence}" is not one of ${[...ALLOWED_LICENCES].join(', ')}. ` +
        'Fonts in the OCR corpus must be redistributable — see tools/golden-images/README.md.',
    )
  }

  const subsets = metadata.subsets
    .filter(name => unicode[name] !== undefined)
    .map(name => ({ name, ranges: parseUnicodeRange(unicode[name]!), range: unicode[name]! }))
  if (subsets.length === 0) throw new Error(`${pkg}: no subset has a unicode range`)

  return {
    pkg,
    family: metadata.family,
    category: categoryOf(metadata.category, pkg),
    licence,
    attribution: redactEmails(metadata.license.attribution),
    subsets,
  }
}

/** Read one installed `@fontsource/*` package. */
export function loadFont(pkg: string): Font {
  const metadata = JSON.parse(
    readFileSync(require.resolve(`${pkg}/metadata.json`), 'utf8'),
  ) as FontsourceMetadata
  const unicode = JSON.parse(
    readFileSync(require.resolve(`${pkg}/unicode.json`), 'utf8'),
  ) as Record<string, string>
  return fontFrom(pkg, metadata, unicode)
}

function inRanges(code: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([start, end]) => code >= start && code <= end)
}

/**
 * The subsets a font needs to draw `text`, or `null` if it cannot draw all of it.
 *
 * `null` rather than a partial list on purpose. A caller handed "the subsets that cover
 * most of it" would render a document with a few characters missing — which is precisely
 * the silent-fallback case this module exists to prevent.
 */
export function subsetsFor(font: Font, text: string): string[] | null {
  const needed = new Set<string>()
  for (const char of text) {
    const code = char.codePointAt(0)!
    // Newlines are layout, not glyphs: a document is many lines and no font draws them.
    if (code === 0x0a || code === 0x0d) continue
    const subset = font.subsets.find(candidate => inRanges(code, candidate.ranges))
    if (subset === undefined) return null
    needed.add(subset.name)
  }
  return [...needed].sort()
}

/** Can this font draw every character in `text`? */
export function covers(font: Font, text: string): boolean {
  return subsetsFor(font, text) !== null
}

export interface CoverageReport {
  readonly total: number
  readonly covered: number
  /** Rows no font in the set can draw, so they never reach an image. */
  readonly uncovered: number
}

/**
 * How much of the seed the installed fonts can actually draw.
 *
 * Reported rather than inferred. The seed is roughly half non-Latin and every
 * handwriting face here is Latin-only, so a large uncovered count is expected — the
 * point is that it is a number in the manifest that moves when the font set changes,
 * instead of a property of the corpus nobody measured.
 */
export function coverageReport(fonts: readonly Font[], texts: readonly string[]): CoverageReport {
  let covered = 0
  for (const text of texts) {
    if (fonts.some(font => covers(font, text))) covered += 1
  }
  return { total: texts.length, covered, uncovered: texts.length - covered }
}

/** The bytes of one subset file, for embedding as a `data:` URI. */
export function subsetFile(font: Font, subset: string, weight: number): Buffer {
  const id = font.pkg.slice('@fontsource/'.length)
  return readFileSync(require.resolve(`${font.pkg}/files/${id}-${subset}-${weight}-normal.woff2`))
}
