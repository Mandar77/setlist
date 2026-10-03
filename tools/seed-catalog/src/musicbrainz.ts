/**
 * A very small MusicBrainz client: one endpoint, rate limited, with `fetch` injected.
 *
 * Only `browse releases by artist` is implemented, because one request to it returns a
 * whole album — tracklist, recording MBIDs, ISRCs and artist credits — and that is the
 * difference between a harvest of twenty requests and a harvest of two thousand. Asking
 * someone else's donation-funded server for the same data a hundred times more slowly
 * would be rude in a way no rate limiter fixes.
 *
 * `fetch` is a constructor parameter so the tests never touch the network. That is not
 * only a speed concern: a test suite that depends on MusicBrainz being up and on an
 * artist's discography never changing is a test suite that fails for reasons that have
 * nothing to do with this repository.
 */

import { RateLimiter, systemClock, type Clock } from './rate-limit.js'

export const MUSICBRAINZ_ROOT = 'https://musicbrainz.org/ws/2'

/**
 * Required by MusicBrainz: a descriptive agent with contact information, or requests are
 * throttled and eventually blocked. The contact is the repository, which is a real
 * address a MusicBrainz admin can reach and is not anybody's personal email — ADR-005
 * keeps those out of a public repo.
 */
export const USER_AGENT = 'setlist-seed-catalog/1.0 (+https://github.com/Mandar77/setlist)'

/** MusicBrainz asks for no more than one request per second per IP. */
export const MIN_INTERVAL_MS = 1000

export type Fetch = (url: string, init: { headers: Record<string, string> }) => Promise<Response>

export interface ArtistCreditJson {
  readonly name?: string
  readonly joinphrase?: string
  readonly artist?: { readonly id?: string; readonly name?: string }
}

export interface RecordingJson {
  readonly id?: string
  readonly title?: string
  /** "live, 1979", "instrumental", "single version" — MusicBrainz's own version note. */
  readonly disambiguation?: string
  readonly length?: number | null
  readonly isrcs?: readonly string[]
  readonly 'artist-credit'?: readonly ArtistCreditJson[]
}

export interface TrackJson {
  readonly title?: string
  readonly recording?: RecordingJson
}

export interface ReleaseJson {
  readonly id?: string
  readonly title?: string
  readonly date?: string
  readonly disambiguation?: string
  readonly 'release-group'?: {
    readonly 'primary-type'?: string
    readonly 'secondary-types'?: readonly string[]
  }
  readonly media?: readonly { readonly tracks?: readonly TrackJson[] }[]
}

export interface ReleaseBrowseJson {
  readonly 'release-count'?: number
  readonly releases?: readonly ReleaseJson[]
}

export class MusicBrainzError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'MusicBrainzError'
  }
}

export interface ClientOptions {
  readonly fetch?: Fetch
  readonly clock?: Clock
  readonly minIntervalMs?: number
  readonly root?: string
  readonly userAgent?: string
}

export class MusicBrainzClient {
  readonly #fetch: Fetch
  readonly #limiter: RateLimiter
  readonly #root: string
  readonly #userAgent: string

  constructor(options: ClientOptions = {}) {
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init))
    this.#limiter = new RateLimiter(
      options.minIntervalMs ?? MIN_INTERVAL_MS,
      options.clock ?? systemClock,
    )
    this.#root = options.root ?? MUSICBRAINZ_ROOT
    this.#userAgent = options.userAgent ?? USER_AGENT
  }

  /**
   * One page of an artist's official albums, each with its full tracklist.
   *
   * `type=album` and not `type=album|live`, which is the trap here: browse ANDs multiple
   * type values rather than ORing them, so `album|live` asks for releases that are both
   * — it returned Daft Punk's four live editions and hid Homework, Discovery and Random
   * Access Memories entirely. A plain `album` is already the superset: live albums have
   * primary type Album and secondary type Live, and `tagsFor` reads the secondary types.
   *
   * `status=official` keeps bootlegs and promos out, which matters because a bootleg
   * tracklist is where misspelled titles and invented track names live.
   */
  async browseReleases(
    artistMbid: string,
    offset: number,
    limit: number,
  ): Promise<ReleaseBrowseJson> {
    const url =
      `${this.#root}/release?artist=${encodeURIComponent(artistMbid)}` +
      `&inc=recordings+isrcs+artist-credits+release-groups` +
      `&type=album&status=official&fmt=json` +
      `&limit=${limit}&offset=${offset}`

    await this.#limiter.acquire()
    const response = await this.#fetch(url, {
      headers: { 'User-Agent': this.#userAgent, Accept: 'application/json' },
    })

    if (!response.ok) {
      throw new MusicBrainzError(
        `MusicBrainz returned ${response.status} for ${url}`,
        response.status,
      )
    }
    return (await response.json()) as ReleaseBrowseJson
  }
}
