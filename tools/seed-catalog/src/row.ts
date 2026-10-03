/**
 * The seed row: one real recording, with enough truth attached to generate text from it.
 *
 * CORE-03 builds the golden text set out of these, and its rule is that expected outputs
 * come only from the seed and never from parser output. That is what makes the golden
 * set a test of the extractor rather than a recording of its current behaviour — so
 * every field here has to be something MusicBrainz asserted, not something we inferred
 * by parsing a string we had already decided how to parse.
 *
 * The one deliberate exception is `tags`, which IS derived. It is derived from structured
 * fields (release-group secondary types, artist-credit arity) rather than from the title
 * text, for the same reason: a tag read out of "(Live)" in a title would be the parser's
 * opinion wearing a ground-truth badge.
 */

/** One credited artist and the text that joins it to the next one. */
export interface CreditedArtist {
  readonly name: string
  readonly mbid: string
  /** MusicBrainz's own join text — " feat. ", " & ", ", ". Empty on the last credit. */
  readonly join: string
}

export type SeedTag = 'live' | 'remaster' | 'feat' | 'non_latin'

export interface SeedRow {
  readonly recording_mbid: string
  readonly title: string
  /**
   * MusicBrainz's own disambiguation for this recording: "live, 1979", "instrumental",
   * "single version", "original studio mix". Empty when there is none.
   *
   * This is the field that carries version information as asserted data rather than as
   * something parsed out of a title, which makes it the only honest source CORE-03 has
   * for "this recording is a different take of that song". Remasters are the gap: MB
   * does not model them here, because a remaster is the same recording.
   */
  readonly version: string
  /** The full credit line as MusicBrainz renders it, e.g. "Justice feat. Uffie". */
  readonly artist: string
  readonly artists: readonly CreditedArtist[]
  /** The canonical ISRC for this recording, or null when it has none. */
  readonly isrc: string | null
  /** Every ISRC MusicBrainz lists, sorted. A recording can carry several. */
  readonly isrcs: readonly string[]
  readonly duration_ms: number | null
  readonly release_mbid: string
  readonly release_title: string
  readonly release_date: string | null
  readonly tags: readonly SeedTag[]
}

/**
 * Render the credit line from its parts.
 *
 * MusicBrainz stores the join text between credits precisely so that "Justice feat.
 * Uffie" and "Simon & Garfunkel" and "Jay‑Z / Linkin Park" all come out right without
 * anyone guessing a separator. Concatenating what it gives us is both simpler and more
 * correct than any rule we would invent.
 */
export function renderCredit(artists: readonly CreditedArtist[]): string {
  return artists
    .map(a => `${a.name}${a.join}`)
    .join('')
    .trim()
}

/**
 * Does this string contain a character outside the Latin scripts?
 *
 * Used to tag rows that exercise the non-Latin path. Deliberately not "is this entirely
 * non-Latin": a title like "君の名は (Your Name)" is exactly the mixed case worth having
 * in the set, and an all-or-nothing test would throw it away.
 *
 * Latin-1 punctuation, digits and spaces do not count as evidence either way, so a plain
 * ASCII title is not tagged and a title that is ASCII apart from an accent is not either
 * — `é` is Latin script. The tag means "another writing system appears here".
 */
export function hasNonLatinScript(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code === undefined) continue
    // Below U+0370 is Latin, Latin-1, Latin Extended A/B, IPA, spacing modifiers and
    // combining marks — all of them Latin-script or script-neutral.
    if (code < 0x0370) continue
    // General punctuation, currency, arrows, maths, and the CJK punctuation block carry
    // no script of their own; an em dash is not evidence of Japanese.
    if (code >= 0x2000 && code <= 0x2bff) continue
    if (code >= 0xfe00 && code <= 0xfe0f) continue // variation selectors
    return true
  }
  return false
}

/** Characters MusicBrainz uses to mark a featured credit, in its own join text. */
const FEATURE_JOIN = /\bfeat\.?\b|\bfeaturing\b|\bwith\b/i

export interface TagInput {
  readonly artists: readonly CreditedArtist[]
  readonly title: string
  readonly version: string
  readonly artist: string
  /** Release-group secondary types, e.g. ["Live"], ["Compilation"]. */
  readonly secondaryTypes: readonly string[]
  /** Release-level disambiguation and title, where "remaster" is usually recorded. */
  readonly releaseTitle: string
  readonly releaseDisambiguation: string
}

/**
 * Classify a row from structured evidence.
 *
 * Each tag has exactly one source and it is never the recording title:
 *
 * * `live` — the release group is typed Live by MusicBrainz editors.
 * * `remaster` — the release says so. Remasters are a property of the *release*, which is
 *   why "(Remastered 2011)" sits in a release title rather than in a recording.
 * * `feat` — the credit has more than one artist and MusicBrainz's own join text says
 *   featuring. Two artists joined by "&" are a duo, not a feature.
 * * `non_latin` — another writing system appears in the title or the credit.
 */
export function tagsFor(input: TagInput): SeedTag[] {
  const tags: SeedTag[] = []

  if (input.secondaryTypes.some(t => t.toLowerCase() === 'live')) tags.push('live')

  // Both places a remaster can be asserted, which in practice is almost always the
  // release title. MusicBrainz keeps one recording for a song however many times it is
  // remastered, so the recording-level field is checked for completeness rather than in
  // expectation of finding anything.
  const remasterText =
    `${input.releaseTitle} ${input.releaseDisambiguation} ${input.version}`.toLowerCase()
  if (remasterText.includes('remaster')) tags.push('remaster')

  if (input.artists.length > 1 && input.artists.some(a => FEATURE_JOIN.test(a.join))) {
    tags.push('feat')
  }

  if (hasNonLatinScript(input.title) || hasNonLatinScript(input.artist)) tags.push('non_latin')

  return tags
}

/**
 * Serialize one row to a JSONL line.
 *
 * Keys written in a fixed order rather than left to object-literal order, and the whole
 * file sorted by `recording_mbid` before it is written, so that re-harvesting produces
 * the same bytes when it found the same data. A seed file whose diff is pure reordering
 * is a seed file nobody reviews.
 */
export function toLine(row: SeedRow): string {
  const ordered = {
    recording_mbid: row.recording_mbid,
    title: row.title,
    version: row.version,
    artist: row.artist,
    artists: row.artists,
    isrc: row.isrc,
    isrcs: row.isrcs,
    duration_ms: row.duration_ms,
    release_mbid: row.release_mbid,
    release_title: row.release_title,
    release_date: row.release_date,
    tags: row.tags,
  }
  return JSON.stringify(ordered)
}
