/**
 * What the extractor is supposed to return, derived from the seed and nothing else.
 *
 * This is the whole point of CORE-03's "expected outputs derived only from the seed,
 * never from parser output". A golden set built by running the parser and writing down
 * what it said is not a test; it is a recording of current behaviour that will agree
 * with any future bug introduced before the next regeneration.
 *
 * So the rules below take a `SeedRow` — real MusicBrainz data — and compute the expected
 * answer from its *structure*. The one place that needs care is the artist credit, where
 * the expected value is not simply `row.artist`.
 */

import type { SeedRow } from './seed.js'

/**
 * Where a credit stops being the primary artist.
 *
 * This mirrors `_INLINE_FEAT_RE` in `tools/oracle-py/src/setlist_core/normalize.py`, and
 * mirroring it is the risky part of this file: two copies of a rule drift. The contract
 * it encodes is documented and narrow — `split_artist_credits` separates
 * "Calvin Harris feat. Dua Lipa" into a primary and a feature, and deliberately leaves
 * `&`, `x`, `and` and `with` alone because those are part of the credit as providers
 * spell it.
 *
 * `agreesWithTheContract` in the tests checks the two against each other on real rows,
 * so a divergence fails rather than quietly producing a corpus of wrong expectations.
 */
const FEAT_JOIN = /^\s*(?:feat\.|ft\.|featuring)\s*$/i

/** The expected answer for one row, as the accuracy gate will compare it. */
export interface Truth {
  readonly title: string
  readonly artist: string
}

/**
 * The primary credit: everything before the first `feat.` join.
 *
 * Built from the seed's own join phrases rather than by splitting `row.artist` on a
 * separator, because MusicBrainz already recorded where each credit ends and what joins
 * it to the next. Re-deriving that from the rendered string would be guessing at
 * something we were told.
 */
export function primaryArtist(row: SeedRow): string {
  const parts: string[] = []
  for (const credit of row.artists) {
    parts.push(credit.name)
    if (FEAT_JOIN.test(credit.join)) break
    parts.push(credit.join)
  }
  return parts.join('').trim()
}

/** Every credit after the first `feat.` join. */
export function featuredArtists(row: SeedRow): string[] {
  const index = row.artists.findIndex(credit => FEAT_JOIN.test(credit.join))
  return index === -1 ? [] : row.artists.slice(index + 1).map(credit => credit.name)
}

/** Does this row's credit carry a featured artist? */
export function hasFeature(row: SeedRow): boolean {
  return featuredArtists(row).length > 0
}

/**
 * The expected extraction for a row.
 *
 * The title is the seed title verbatim. Anything a renderer *adds* to it — "(Live)",
 * "(2011 Remaster)" — is a qualifier the extractor is contracted to peel off into hints
 * (PRD §7.9.1), so the expected title stays the undecorated one. That is a claim about
 * the contract, not about the parser, and the renderers only ever add qualifiers the
 * contract names.
 */
export function truthFor(row: SeedRow): Truth {
  return { title: row.title, artist: primaryArtist(row) }
}

/**
 * Is this row usable as ground truth at all?
 *
 * Some real catalogue entries make terrible golden cases regardless of how they are
 * rendered, and including them would score the extractor against text no human would
 * paste. Each exclusion is about the row, never about whether the parser handles it.
 */
export function isUsable(row: SeedRow): boolean {
  const title = row.title.trim()
  const artist = primaryArtist(row).trim()

  if (title === '' || artist === '') return false
  // A "title" this long is a movement description or a medley listing, not something
  // that appears in a song list.
  if (title.length > 90 || artist.length > 70) return false
  // Titles that are only punctuation or digits ("(Jingle)", "1") carry no signal: there
  // is nothing for a parser to get right or wrong.
  if (!/[\p{L}]/u.test(title)) return false
  // A title containing a line break cannot be rendered on one line, and a title holding
  // the separator characters the renderers use would make the case ambiguous for a
  // reason the extractor cannot be blamed for.
  if (/[\n\r\t]/.test(title) || /[\n\r\t]/.test(artist)) return false

  // A title that already carries its own annotation — "Too Original (TJR remix)",
  // "Can't Stop Now (Kicks Like a Mule remix)" — is excluded, and this is the subtlest
  // rule here.
  //
  // The extractor is contracted to peel version annotations into hints, so it returns
  // "Too Original". The seed says the title is "Too Original (TJR remix)". Both are
  // defensible and they do not match, so a case built on that row asserts a disagreement
  // about the contract rather than testing extraction. Computing the stripped form here
  // would mean reimplementing `strip_qualifiers` in a second language and keeping the
  // two in step forever — a worse trade than dropping the row.
  //
  // Titles this corpus decorates are decorated by a renderer, which knows exactly what
  // it added and therefore exactly what the answer still is. Rows that arrive already
  // decorated belong in the hand-written corpus, where a human can state the intent.
  if (/[([].{0,40}[)\]]\s*$/.test(title)) return false
  // Same reasoning for a trailing " - Live" style annotation.
  if (/\s[-–—]\s*\S{1,20}\s*$/.test(title)) return false

  // A separator inside a title would split the rendered line in the wrong place, and the
  // extractor would be right to do it.
  if (/\s[-–—~|/•·]\s/.test(title) || /\s[-–—~|/•·]\s/.test(artist)) return false
  // Likewise a literal " by ", which is the other shape a renderer uses.
  if (/\sby\s/i.test(title)) return false
  return true
}
