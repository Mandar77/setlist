/**
 * Check the committed seed against what CORE-02 says it has to be. Offline.
 *
 * The harvest is a thing a person runs occasionally; this is the thing CI runs every
 * time. Separating them matters because the requirements in CORE-02 are properties of
 * the *file*, not of the code that produced it — and a file in git is exactly as
 * trustworthy as the last check somebody ran over it. Without this, "ISRCs on at least
 * 80% of rows" is a sentence in a ledger rather than something that is true.
 *
 * Nothing here makes a network call, so it can live in `make verify` alongside every
 * other gate.
 */

import { readFileSync } from 'node:fs'

import type { SeedRow } from './row.js'

/** "about 2000 rows", read with a band: a harvest is not expected to land on a number. */
export const MIN_ROWS = 1800
export const MAX_ROWS = 3000

/** CORE-02: "ISRCs present on at least 80% of rows". */
export const MIN_ISRC_SHARE = 0.8

/**
 * CORE-02: "includes live, remaster and feat. variants, and non-Latin names".
 *
 * "Includes" needs a number or it means nothing — one row would satisfy it, and one row
 * is what the first harvest produced for `remaster` before anyone looked. These floors
 * are deliberately well under what the harvest currently finds, because the point is to
 * catch a variant disappearing, not to pin the exact count a live database returns.
 */
export const MIN_BY_TAG: Readonly<Record<string, number>> = {
  live: 100,
  remaster: 50,
  feat: 100,
  non_latin: 150,
}

const ISRC = /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/

export function parse(text: string): SeedRow[] {
  return text
    .split('\n')
    .filter(line => line.trim() !== '')
    .map((line, index) => {
      try {
        return JSON.parse(line) as SeedRow
      } catch {
        throw new Error(`line ${index + 1} is not valid JSON`)
      }
    })
}

export function problems(rows: readonly SeedRow[]): string[] {
  const found: string[] = []

  if (rows.length < MIN_ROWS) found.push(`${rows.length} rows, expected at least ${MIN_ROWS}`)
  if (rows.length > MAX_ROWS) {
    found.push(`${rows.length} rows, more than ${MAX_ROWS} — is this still "about 2000"?`)
  }
  if (rows.length === 0) return found

  const withIsrc = rows.filter(r => r.isrc !== null).length
  const share = withIsrc / rows.length
  if (share < MIN_ISRC_SHARE) {
    found.push(
      `${(100 * share).toFixed(1)}% of rows carry an ISRC, below the ` +
        `${100 * MIN_ISRC_SHARE}% floor (${withIsrc}/${rows.length})`,
    )
  }

  for (const [tag, floor] of Object.entries(MIN_BY_TAG)) {
    const count = rows.filter(r => r.tags.includes(tag as SeedRow['tags'][number])).length
    if (count < floor) found.push(`only ${count} row(s) tagged ${tag}, expected at least ${floor}`)
  }

  // Structure. A malformed row is worse than a missing one: CORE-03 derives expected
  // outputs from these fields, so a blank title becomes a golden case asserting that the
  // extractor should find a song with no name.
  const seen = new Set<string>()
  let previous = ''
  for (const [index, row] of rows.entries()) {
    const where = `row ${index + 1} (${row.recording_mbid ?? 'no mbid'})`
    if (!row.recording_mbid) found.push(`${where}: no recording_mbid`)
    if (!row.title || row.title.trim() === '') found.push(`${where}: empty title`)
    if (!row.artist || row.artist.trim() === '') found.push(`${where}: empty artist`)
    if (!Array.isArray(row.artists) || row.artists.length === 0) found.push(`${where}: no credits`)
    if (row.isrc !== null && !ISRC.test(row.isrc))
      found.push(`${where}: malformed ISRC ${row.isrc}`)
    if (row.isrc !== null && !row.isrcs.includes(row.isrc)) {
      found.push(`${where}: canonical ISRC is not in the isrcs list`)
    }

    if (seen.has(row.recording_mbid)) found.push(`${where}: duplicate recording_mbid`)
    seen.add(row.recording_mbid)

    // Sorted, because the file is regenerated and reviewed as a diff. An unsorted file
    // reorders on every harvest and the diff stops being readable, which is the same as
    // not being reviewed.
    if (row.recording_mbid < previous) found.push(`${where}: file is not sorted by recording_mbid`)
    previous = row.recording_mbid
  }

  return found.slice(0, 25)
}

export function summarize(rows: readonly SeedRow[]): string {
  const withIsrc = rows.filter(r => r.isrc !== null).length
  const counts = Object.keys(MIN_BY_TAG)
    .map(
      tag => `${tag} ${rows.filter(r => r.tags.includes(tag as SeedRow['tags'][number])).length}`,
    )
    .join(', ')
  const share = rows.length === 0 ? 0 : (100 * withIsrc) / rows.length
  return `${rows.length} rows, ${withIsrc} with an ISRC (${share.toFixed(1)}%); ${counts}`
}

export function verifyFile(path: string): number {
  let rows: SeedRow[]
  try {
    rows = parse(readFileSync(path, 'utf8'))
  } catch (error) {
    console.error(`seed catalog: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }

  const found = problems(rows)
  if (found.length > 0) {
    console.error(`seed catalog: ${found.length} problem(s) in ${path}:`)
    for (const problem of found) console.error(`  - ${problem}`)
    return 1
  }
  console.log(`seed catalog: ${summarize(rows)}`)
  return 0
}
