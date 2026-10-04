/**
 * YouTube Data API v3 quota accounting, as the real thing does it (PED D16, §11).
 *
 * Two buckets, not one, and that is the detail everything else here exists to model.
 *
 *   * The **unit** bucket: 10,000 units a day, shared across the whole project. Every
 *     call costs units — `playlists.insert` and `playlistItems.insert` cost 50 each,
 *     `search.list` costs 100.
 *   * The **search.list call** bucket: a separate default of 100 CALLS a day, counted in
 *     calls rather than units and exhausted independently.
 *
 * A simulator with one bucket would let a test burn 10,000 units on `search.list` and
 * report success at 100 calls, which is the opposite of what happens: the call bucket
 * runs out first, at 100 calls and 10,000 units, and in practice far sooner because the
 * units are needed for inserts. PED §7.10.1's "resolve by ISRC first" is a direct
 * consequence, and a simulator that cannot reproduce the constraint cannot be used to
 * test the strategy that exists because of it.
 *
 * The numbers are not configurable. They are the provider's, and a test that passes
 * against invented quota is a test that proves nothing — the per-env SHARES in
 * budget.yaml are ours to set, the costs are not.
 */

/** Unit cost per method (PED D16). */
export const UNIT_COSTS = Object.freeze({
  'search.list': 100,
  'playlists.insert': 50,
  'playlistItems.insert': 50,
  'playlists.list': 1,
  'playlistItems.list': 1,
  'videos.list': 1,
})

export type Method = keyof typeof UNIT_COSTS

/** The project-wide daily unit allowance. */
export const DAILY_UNITS = 10_000
/** The separate daily allowance for `search.list`, counted in CALLS. */
export const DAILY_SEARCH_CALLS = 100

export interface QuotaState {
  readonly unitsUsed: number
  readonly searchCallsUsed: number
}

export const EMPTY_QUOTA: QuotaState = Object.freeze({ unitsUsed: 0, searchCallsUsed: 0 })

/** Which bucket ran out. `null` means the call fits. */
export type Exhausted = 'units' | 'search_calls' | null

/**
 * Would this call fit? Checked BEFORE charging, because the real API rejects the whole
 * call rather than partially charging for it.
 */
export function wouldExhaust(
  state: QuotaState,
  method: Method,
  limits: { units: number; searchCalls: number } = {
    units: DAILY_UNITS,
    searchCalls: DAILY_SEARCH_CALLS,
  },
): Exhausted {
  if (method === 'search.list' && state.searchCallsUsed + 1 > limits.searchCalls) {
    return 'search_calls'
  }
  if (state.unitsUsed + UNIT_COSTS[method] > limits.units) return 'units'
  return null
}

/** Charge a call. The caller must have checked `wouldExhaust` first. */
export function charge(state: QuotaState, method: Method): QuotaState {
  return Object.freeze({
    unitsUsed: state.unitsUsed + UNIT_COSTS[method],
    searchCallsUsed: state.searchCallsUsed + (method === 'search.list' ? 1 : 0),
  })
}

/**
 * The unit cost of creating a playlist of `trackCount` songs.
 *
 * PED §11: `50 + n * 50`. Stated as a function so the arithmetic lives in one place and
 * `estimate` and the simulator cannot disagree about it.
 */
export function playlistCost(trackCount: number): number {
  return UNIT_COSTS['playlists.insert'] + trackCount * UNIT_COSTS['playlistItems.insert']
}
