/**
 * Walk the curated artists, turn releases into seed rows, and be interruptible.
 *
 * Resumability is a requirement rather than a nicety, and the reason is the rate limit.
 * At one request per second a full harvest is minutes of wall clock during which a
 * laptop can sleep, a network can drop or someone can press Ctrl-C — and the wrong
 * response to any of those is to start over and spend MusicBrainz's bandwidth again on
 * data already collected. So progress is written after every page: which artist, which
 * offset, and the rows found so far.
 *
 * The state file is the resume point and the rows file is the output, kept separate
 * because they answer different questions. State is scratch and is deleted when the
 * harvest completes; rows are the artifact and are committed.
 */

import type { MusicBrainzClient, ReleaseJson } from './musicbrainz.js'
import { SEED_ARTISTS, type SeedArtist } from './artists.js'
import { renderCredit, tagsFor, type CreditedArtist, type SeedRow } from './row.js'

/** Releases per request. MusicBrainz caps browse at 100; with `inc=recordings` the
 *  responses get large, and 25 keeps a retry cheap without costing extra round trips
 *  on artists whose album count is in the dozens. */
export const RELEASES_PER_PAGE = 25

export interface HarvestState {
  /** MBIDs finished, so a resumed run skips them outright. */
  readonly completed: string[]
  /** Where to pick up inside the artist that was in flight, if any. */
  readonly inFlight: { readonly mbid: string; readonly offset: number } | null
}

export const EMPTY_STATE: HarvestState = { completed: [], inFlight: null }

export interface Store {
  readState(): Promise<HarvestState | null>
  writeState(state: HarvestState): Promise<void>
  clearState(): Promise<void>
  /** Rows already harvested, keyed by recording MBID. */
  readRows(): Promise<SeedRow[]>
  writeRows(rows: readonly SeedRow[]): Promise<void>
}

export interface HarvestOptions {
  readonly client: MusicBrainzClient
  readonly store: Store
  readonly artists?: readonly SeedArtist[]
  /** Stop once this many distinct recordings have been collected. */
  readonly targetRows?: number
  /**
   * Stop taking from an artist once it has contributed this many rows.
   *
   * Not a performance knob — it is what makes the curation mean anything. Artists are
   * walked in list order, so a bare row target stops partway down the list and the set
   * ends up being whoever happens to be at the top. The non-Latin entries are at the
   * bottom of `artists.ts`, so without a cap the one requirement the list exists to
   * satisfy is the one the harvest never reaches.
   */
  readonly maxRowsPerArtist?: number
  /**
   * The share of an artist's rows that may lack an ISRC, as a fraction.
   *
   * CORE-02 wants ISRCs on at least 80% of the file, and MusicBrainz's ISRC data is not
   * evenly distributed: it is close to complete for modern Western releases and close to
   * absent for older non-Western ones. Άννα Βίσση came back 0/67, أم كلثوم 0/46, فيروز
   * 0/52, Lata Mangeshkar 1/70 — and those are the artists the list carries *for* their
   * scripts, so dropping them to make a number go up would trade the requirement that is
   * hard to satisfy for the one that is easy to measure.
   *
   * Applying the budget per artist instead of to the file as a whole keeps everyone in
   * the set and bounds what the sparse catalogues cost: an artist with no ISRCs at all
   * still contributes, just a fifth as much.
   */
  readonly plainShare?: number
  /** How many pages to walk per artist before accepting what was found. */
  readonly maxPagesPerArtist?: number
  /** Pages to sweep backwards from the end of an artist's releases, hunting remasters. */
  readonly remasterPages?: number
  /** Extra rows an artist may contribute beyond its share, when they are remasters. */
  readonly remasterBonus?: number
  readonly releasesPerPage?: number
  readonly log?: (message: string) => void
}

export interface HarvestSummary {
  readonly rows: number
  readonly requests: number
  readonly withIsrc: number
  readonly resumed: boolean
}

/**
 * Secondary types a release may carry and still be harvested from.
 *
 * Empty means a studio album. `Live` is the one addition, because live rows are
 * something CORE-02 explicitly requires the seed to contain.
 *
 * Everything else is excluded, and the reason showed up in the data rather than in
 * principle: on a first pass over Daft Punk, ISRC coverage came out at 55%, and every
 * zero-ISRC release was a compilation of videos or an interview disc — Interstella 5555
 * at 0/27, D.A.F.T. at 0/16, a radio interview at 0/1. Those are not song lists anybody
 * would paste, their "tracks" are film chapters, and they were dragging a real quality
 * measure down with material that does not belong in the set.
 *
 * Compilations are excluded even when their ISRC coverage is perfect, for a different
 * reason: their recordings are the same recordings as on the original albums, so they
 * contribute duplicates that dedup then has to throw away.
 */
export const ALLOWED_SECONDARY_TYPES = new Set(['live'])

/** Is this a release the seed should take recordings from? */
export function isSeedWorthy(release: ReleaseJson): boolean {
  const group = release['release-group']
  if (group === undefined) return false
  if ((group['primary-type'] ?? '').toLowerCase() !== 'album') return false
  return (group['secondary-types'] ?? []).every(t => ALLOWED_SECONDARY_TYPES.has(t.toLowerCase()))
}

/**
 * Flatten one release into rows.
 *
 * A release can list the same recording twice — a bonus disc that repeats the album, a
 * "radio edit" pointing at the same recording MBID. Deduplication happens by MBID at the
 * harvest level rather than here, because the duplicate is often across releases rather
 * than within one.
 */
export function rowsFromRelease(release: ReleaseJson): SeedRow[] {
  const releaseMbid = release.id
  const releaseTitle = release.title
  if (releaseMbid === undefined || releaseTitle === undefined) return []

  const secondaryTypes = release['release-group']?.['secondary-types'] ?? []
  const releaseDisambiguation = release.disambiguation ?? ''
  const rows: SeedRow[] = []

  for (const medium of release.media ?? []) {
    for (const track of medium.tracks ?? []) {
      const recording = track.recording
      if (recording?.id === undefined) continue

      // The recording's own title, not the track title. They differ when a release
      // relabels a track ("Intro" for a recording that is actually a named piece), and
      // the recording is the thing a provider will be asked to match.
      const title = recording.title ?? track.title
      if (title === undefined || title.trim() === '') continue

      const artists: CreditedArtist[] = []
      for (const credit of recording['artist-credit'] ?? []) {
        const name = credit.name ?? credit.artist?.name
        const mbid = credit.artist?.id
        if (name === undefined || mbid === undefined) continue
        artists.push({ name, mbid, join: credit.joinphrase ?? '' })
      }
      if (artists.length === 0) continue

      const artist = renderCredit(artists)
      const isrcs = [...(recording.isrcs ?? [])].sort()

      const version = recording.disambiguation ?? ''

      rows.push({
        recording_mbid: recording.id,
        title,
        version,
        artist,
        artists,
        // The lowest-sorting ISRC, chosen only because it is deterministic. A recording
        // with several has them because it was released in several territories, and
        // MusicBrainz does not say which is canonical — so neither does this.
        isrc: isrcs[0] ?? null,
        isrcs,
        duration_ms: typeof recording.length === 'number' ? recording.length : null,
        release_mbid: releaseMbid,
        release_title: releaseTitle,
        release_date: release.date ?? null,
        tags: tagsFor({
          artists,
          title,
          version,
          artist,
          secondaryTypes,
          releaseTitle,
          releaseDisambiguation,
        }),
      })
    }
  }
  return rows
}

/** Rows in the one order the file is ever written in. */
export function sortRows(rows: readonly SeedRow[]): SeedRow[] {
  return [...rows].sort((a, b) =>
    a.recording_mbid < b.recording_mbid ? -1 : a.recording_mbid > b.recording_mbid ? 1 : 0,
  )
}

export async function harvest(options: HarvestOptions): Promise<HarvestSummary> {
  const { client, store } = options
  const artists = options.artists ?? SEED_ARTISTS
  const target = options.targetRows ?? 2000
  // The target is reached by giving every artist an equal share, not by stopping when
  // the count is hit. Stopping produced 2,069 rows from the first sixteen names on the
  // list and nothing at all from the last thirteen — which are the non-Latin ones, so
  // the single hardest requirement in CORE-02 came out at zero while the row count
  // looked perfect.
  const perArtist = options.maxRowsPerArtist ?? Math.ceil(target / artists.length)
  const plainShare = options.plainShare ?? 0.2
  const plainQuota = Math.floor(perArtist * plainShare)
  const maxPages = options.maxPagesPerArtist ?? 8
  const remasterPages = options.remasterPages ?? 3
  const remasterBonus = options.remasterBonus ?? 10
  const perPage = options.releasesPerPage ?? RELEASES_PER_PAGE
  const log = options.log ?? (() => undefined)

  const previous = (await store.readState()) ?? EMPTY_STATE
  const resumed = previous.completed.length > 0 || previous.inFlight !== null

  const byMbid = new Map<string, SeedRow>()
  for (const row of await store.readRows()) byMbid.set(row.recording_mbid, row)
  if (resumed) {
    log(`resuming: ${previous.completed.length} artist(s) done, ${byMbid.size} row(s) kept`)
  }

  const completed = new Set(previous.completed)
  let inFlight = previous.inFlight
  let requests = 0

  const persist = async (state: HarvestState): Promise<void> => {
    await store.writeRows(sortRows([...byMbid.values()]))
    await store.writeState(state)
  }

  for (const artist of artists) {
    if (completed.has(artist.mbid)) continue

    let offset = inFlight?.mbid === artist.mbid ? inFlight.offset : 0
    inFlight = null
    let fromThisArtist = 0
    let plainFromThisArtist = 0
    let pagesForThisArtist = 0
    // No initializer: the page loop below always runs at least once and always
    // assigns this before the sweep reads it, so a starting value would be one
    // nothing can observe.
    let releaseTotal: number

    for (;;) {
      const page = await client.browseReleases(artist.mbid, offset, perPage)
      requests += 1
      pagesForThisArtist += 1

      const releases = page.releases ?? []
      for (const release of releases) {
        // Checked per release, not per page. One page of 25 albums can be 200 recordings,
        // so a cap tested only between pages lets an artist overshoot its share by
        // triple — which is how Caetano Veloso contributed 205 rows against a cap of 104.
        if (fromThisArtist >= perArtist) break
        if (!isSeedWorthy(release)) continue
        for (const row of rowsFromRelease(release)) {
          // One recording, one row. A song on both the original album and its remaster
          // is the same recording MBID, and two rows would double-count it in the ISRC
          // share and hand CORE-03 the same song twice.
          //
          // Which copy wins: the one with an ISRC, else the one seen first. ISRCs hang
          // off the recording, so in principle every release's view of it agrees — in
          // practice MusicBrainz's data is uneven, and a row that knows the ISRC is
          // strictly more useful than one that does not. The fallback keeps it
          // deterministic, since artists are walked in a fixed order.
          const existing = byMbid.get(row.recording_mbid)
          if (existing !== undefined) {
            // Already have it. Upgrade only if this copy knows the ISRC and the other
            // did not; the row count is unchanged either way.
            if (existing.isrc === null && row.isrc !== null) byMbid.set(row.recording_mbid, row)
            continue
          }
          if (fromThisArtist >= perArtist) break
          // A row with no ISRC comes out of a small separate budget. Without it an
          // artist whose catalogue MusicBrainz has no ISRCs for fills its whole share
          // with rows that cannot anchor a match, and the file's ISRC coverage is
          // decided by whichever artists happen to be in the list.
          if (row.isrc === null) {
            if (plainFromThisArtist >= plainQuota) continue
            plainFromThisArtist += 1
          }
          byMbid.set(row.recording_mbid, row)
          fromThisArtist += 1
        }
      }

      offset += releases.length
      const total = page['release-count'] ?? 0
      releaseTotal = total
      const done =
        releases.length === 0 ||
        offset >= total ||
        fromThisArtist >= perArtist ||
        pagesForThisArtist >= maxPages

      await persist({
        completed: [...completed],
        inFlight: done ? null : { mbid: artist.mbid, offset },
      })
      log(`${artist.name}: ${offset}/${total} releases, ${byMbid.size} rows`)

      if (done) break
    }

    // A short sweep from the far end of the artist's releases, for remasters only.
    //
    // MusicBrainz does not model a remaster as its own recording — a remaster is the
    // same performance, remastered — so the only place it is asserted is a release, and
    // reissues sit late in browse order. Queen's first three pages mention "remaster"
    // zero times; page eight mentions it 43 times out of 100. Paging there for every
    // artist would cost hundreds of requests, so this walks backwards from the end
    // instead and stops as soon as it has some.
    //
    // Rows found here mostly merge into rows already collected, since it is the same
    // recording seen through a different release. That is the point: the tag moves onto
    // the row rather than duplicating it.
    const total = releaseTotal
    for (let page = 1; page <= remasterPages && total > perPage; page += 1) {
      const sweepOffset = Math.max(0, total - page * perPage)
      if (sweepOffset === 0 && page > 1) break

      const found = await client.browseReleases(artist.mbid, sweepOffset, perPage)
      requests += 1

      let gained = 0
      for (const release of found.releases ?? []) {
        if (!isSeedWorthy(release)) continue
        for (const row of rowsFromRelease(release)) {
          if (!row.tags.includes('remaster')) continue
          const existing = byMbid.get(row.recording_mbid)
          if (existing === undefined) {
            if (fromThisArtist >= perArtist + remasterBonus) continue
            if (row.isrc === null && plainFromThisArtist >= plainQuota) continue
            if (row.isrc === null) plainFromThisArtist += 1
            byMbid.set(row.recording_mbid, row)
            fromThisArtist += 1
          } else if (!existing.tags.includes('remaster')) {
            // Same recording, now known to have a remastered release. Keep the row that
            // has the ISRC and give it the tag.
            const keep = existing.isrc !== null ? existing : row
            byMbid.set(row.recording_mbid, {
              ...keep,
              tags: [...new Set([...existing.tags, ...row.tags])] as SeedRow['tags'],
            })
          }
          gained += 1
        }
      }
      if (gained > 0) break
    }

    completed.add(artist.mbid)
    await persist({ completed: [...completed], inFlight: null })
  }

  const rows = sortRows([...byMbid.values()])
  await store.writeRows(rows)
  await store.clearState()

  return {
    rows: rows.length,
    requests,
    withIsrc: rows.filter(r => r.isrc !== null).length,
    resumed,
  }
}
