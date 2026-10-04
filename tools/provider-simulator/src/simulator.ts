/**
 * The simulator itself: an offline stand-in for the YouTube Data API v3.
 *
 * CLAUDE.md: "Never call a real provider API in a unit test — use
 * tools/provider-simulator." This is that tool. It exists so the quota-sensitive code
 * paths can be tested at all: a real call costs units from a 10,000/day allowance shared
 * with production, and a test suite that ran twice would exhaust a day's budget.
 *
 * It is deterministic by construction. Ids are derived from a counter, not generated, so
 * a contract fixture recorded today still matches tomorrow — a simulator that returned a
 * fresh uuid per call would make every recorded fixture a single-use artifact.
 *
 * Failures are scripted rather than random. `failures` is a queue the test fills, and
 * each call consumes at most one entry: a test that needs "the third insert is rate
 * limited, then it succeeds" says exactly that, instead of seeding a PRNG and hoping.
 */

import {
  EMPTY_QUOTA,
  type Method,
  type QuotaState,
  UNIT_COSTS,
  charge,
  wouldExhaust,
} from './quota.js'
import { type YouTubeApiError, quotaExceeded } from './errors.js'

export interface SimulatorOptions {
  /** Defaults to the real project-wide allowance. */
  readonly units?: number
  /** Defaults to the real separate search.list bucket. */
  readonly searchCalls?: number
  /**
   * Scripted failures, consumed in order. `null` entries let a call through, so a test
   * can say "succeed, succeed, then 429".
   */
  readonly failures?: readonly (YouTubeApiError | null)[]
}

export interface CallRecord {
  readonly method: Method
  readonly cost: number
  readonly ok: boolean
}

export interface Playlist {
  readonly id: string
  readonly itemIds: readonly string[]
}

export class YouTubeSimulator {
  private quota: QuotaState = EMPTY_QUOTA
  private readonly limits: { units: number; searchCalls: number }
  private readonly failures: (YouTubeApiError | null)[]
  private readonly playlists = new Map<string, string[]>()
  private counter = 0
  private readonly calls: CallRecord[] = []

  constructor(options: SimulatorOptions = {}) {
    this.limits = {
      units: options.units ?? 10_000,
      searchCalls: options.searchCalls ?? 100,
    }
    this.failures = [...(options.failures ?? [])]
  }

  /** Every call made, in order, with what it cost. */
  get log(): readonly CallRecord[] {
    return this.calls
  }

  get state(): QuotaState {
    return this.quota
  }

  /** Units still available in the project-wide bucket. */
  get unitsRemaining(): number {
    return this.limits.units - this.quota.unitsUsed
  }

  /** `search.list` CALLS still available in its own bucket. */
  get searchCallsRemaining(): number {
    return this.limits.searchCalls - this.quota.searchCallsUsed
  }

  /**
   * Charge a call and apply any scripted failure.
   *
   * Order matters and mirrors the real API: quota is checked first, so an exhausted
   * project fails with `quotaExceeded` even when a rate-limit failure was scripted next.
   * A scripted failure does NOT consume quota, because a request the API rejected before
   * executing was not served.
   */
  private attempt(method: Method): void {
    const exhausted = wouldExhaust(this.quota, method, this.limits)
    if (exhausted !== null) {
      this.calls.push({ method, cost: 0, ok: false })
      throw quotaExceeded()
    }

    if (this.failures.length > 0) {
      const scripted = this.failures.shift()
      if (scripted) {
        this.calls.push({ method, cost: 0, ok: false })
        throw scripted
      }
    }

    this.quota = charge(this.quota, method)
    this.calls.push({ method, cost: UNIT_COSTS[method], ok: true })
  }

  private nextId(prefix: string): string {
    this.counter += 1
    return `${prefix}${String(this.counter).padStart(6, '0')}`
  }

  /** 100 units, and one call from the separate 100/day bucket. */
  search(query: string): { videoId: string; query: string } {
    this.attempt('search.list')
    return { videoId: this.nextId('vid_'), query }
  }

  /** 50 units. */
  createPlaylist(): Playlist {
    this.attempt('playlists.insert')
    const id = this.nextId('pl_')
    this.playlists.set(id, [])
    return { id, itemIds: [] }
  }

  /** 50 units per item — one call per track, never a batch. */
  addItem(playlistId: string, videoId: string): { itemId: string } {
    this.attempt('playlistItems.insert')
    const items = this.playlists.get(playlistId)
    if (items === undefined) throw new Error(`no such playlist ${playlistId}`)
    const itemId = this.nextId('pli_')
    items.push(videoId)
    return { itemId }
  }

  /** 1 unit. */
  getPlaylist(playlistId: string): Playlist {
    this.attempt('playlists.list')
    const items = this.playlists.get(playlistId) ?? []
    return { id: playlistId, itemIds: [...items] }
  }
}
