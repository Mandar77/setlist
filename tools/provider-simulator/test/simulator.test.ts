// The YouTube simulator (M3-05).
//
// The tests that matter are the ones about the two buckets. A simulator with a single
// pooled quota passes every obvious test and is wrong in the one way that changes the
// design: it lets `search.list` run until the units are gone, when in reality the
// separate 100-call bucket stops it at 100 — which is why PED §7.10.1 resolves by ISRC
// before it searches at all.

import { describe, expect, it } from 'vitest'

import {
  DAILY_SEARCH_CALLS,
  DAILY_UNITS,
  ERROR_FIXTURES,
  FIFTEEN_SONG_JOB,
  UNIT_COSTS,
  YouTubeApiError,
  YouTubeSimulator,
  backendError,
  playlistCost,
  quotaExceeded,
  rateLimited,
} from '../src/index.js'

describe('unit costs are the provider’s, not ours', () => {
  it.each([
    ['search.list', 100],
    ['playlists.insert', 50],
    ['playlistItems.insert', 50],
  ] as const)('%s costs %i units (PED D16)', (method, cost) => {
    expect(UNIT_COSTS[method]).toBe(cost)
  })

  it('a 15-song playlist costs 800 units', () => {
    // 50 + 15 * 50. The binding constraint on the whole system, and the number ADR-008
    // is an argument about.
    expect(playlistCost(15)).toBe(800)
    expect(FIFTEEN_SONG_JOB.expectedUnits).toBe(800)
  })

  it('the daily allowances are the real ones', () => {
    expect(DAILY_UNITS).toBe(10_000)
    expect(DAILY_SEARCH_CALLS).toBe(100)
  })
})

describe('charging', () => {
  it('a 15-song job spends exactly 800 units', () => {
    const sim = new YouTubeSimulator()
    const playlist = sim.createPlaylist()
    for (let i = 0; i < 15; i += 1) sim.addItem(playlist.id, `vid_${i}`)
    expect(sim.state.unitsUsed).toBe(800)
    expect(sim.unitsRemaining).toBe(DAILY_UNITS - 800)
  })

  it('one item per insert, never a batch', () => {
    const sim = new YouTubeSimulator()
    const playlist = sim.createPlaylist()
    for (let i = 0; i < 3; i += 1) sim.addItem(playlist.id, `vid_${i}`)
    const inserts = sim.log.filter(c => c.method === 'playlistItems.insert')
    expect(inserts).toHaveLength(3)
    expect(sim.getPlaylist(playlist.id).itemIds).toHaveLength(3)
  })

  it('search costs units AND a call from the other bucket', () => {
    const sim = new YouTubeSimulator()
    sim.search('daft punk')
    expect(sim.state.unitsUsed).toBe(100)
    expect(sim.state.searchCallsUsed).toBe(1)
  })

  it('an insert costs units but no search call', () => {
    const sim = new YouTubeSimulator()
    sim.createPlaylist()
    expect(sim.state.searchCallsUsed).toBe(0)
  })
})

describe('the two buckets are separate', () => {
  it('search.list exhausts its call bucket long before the units', () => {
    // 100 calls at 100 units each is 10,000 units — exactly the unit allowance — so the
    // two would run out together if the bucket limit were the only thing stopping it.
    // Give the units plenty of room and the call bucket still stops at 100.
    const sim = new YouTubeSimulator({ units: 1_000_000 })
    for (let i = 0; i < DAILY_SEARCH_CALLS; i += 1) sim.search(`q${i}`)
    expect(sim.searchCallsRemaining).toBe(0)
    expect(sim.unitsRemaining).toBeGreaterThan(0)

    expect(() => sim.search('one too many')).toThrow(YouTubeApiError)
  })

  it('an exhausted search bucket does NOT block inserts', () => {
    // The failure a single pooled quota would produce: searching stops, but creating a
    // playlist from already-resolved ISRCs must still work.
    const sim = new YouTubeSimulator({ searchCalls: 1 })
    sim.search('first')
    expect(() => sim.search('second')).toThrow(YouTubeApiError)

    const playlist = sim.createPlaylist()
    expect(playlist.id).toBeTruthy()
  })

  it('exhausted units block everything, including search', () => {
    const sim = new YouTubeSimulator({ units: 50 })
    sim.createPlaylist()
    expect(sim.unitsRemaining).toBe(0)
    expect(() => sim.createPlaylist()).toThrow(YouTubeApiError)
    expect(() => sim.search('anything')).toThrow(YouTubeApiError)
  })

  it('a rejected call costs nothing', () => {
    // The real API rejects the whole call rather than charging part of it.
    const sim = new YouTubeSimulator({ units: 50 })
    sim.createPlaylist()
    const before = sim.state.unitsUsed
    expect(() => sim.createPlaylist()).toThrow()
    expect(sim.state.unitsUsed).toBe(before)
  })
})

describe('failures the adapter must branch on', () => {
  it('quotaExceeded is 403, not retryable, and deferrable', () => {
    const error = quotaExceeded()
    expect(error.status).toBe(403)
    expect(error.reason).toBe('quotaExceeded')
    expect(error.retryable).toBe(false)
    expect(error.deferrable).toBe(true)
    expect(error.retryAfter).toBeNull()
  })

  it('rateLimited is 429, retryable, and carries Retry-After', () => {
    const error = rateLimited(30)
    expect(error.status).toBe(429)
    expect(error.retryAfter).toBe(30)
    expect(error.retryable).toBe(true)
    expect(error.deferrable).toBe(false)
  })

  it('the two 403-ish failures are told apart', () => {
    // Treating them alike either wastes a day waiting for a reset that was not needed,
    // or hammers a rate limit that only wanted a pause.
    expect(quotaExceeded().deferrable).not.toBe(rateLimited(1).deferrable)
    expect(quotaExceeded().retryable).not.toBe(rateLimited(1).retryable)
  })

  it('backendError is retryable with no Retry-After', () => {
    expect(backendError().retryable).toBe(true)
    expect(backendError().retryAfter).toBeNull()
  })

  it('scripted failures fire in order and consume no quota', () => {
    const sim = new YouTubeSimulator({ failures: [null, rateLimited(5)] })
    sim.createPlaylist()
    const used = sim.state.unitsUsed
    expect(() => sim.createPlaylist()).toThrow(/429/)
    expect(sim.state.unitsUsed).toBe(used)
    // ...and the next call goes through, because the queue is exhausted.
    expect(() => sim.createPlaylist()).not.toThrow()
  })

  it('quota is checked before a scripted failure', () => {
    // Mirrors the real API: an exhausted project fails with quotaExceeded whatever else
    // was about to go wrong.
    const sim = new YouTubeSimulator({ units: 0, failures: [rateLimited(5)] })
    try {
      sim.createPlaylist()
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as YouTubeApiError).reason).toBe('quotaExceeded')
    }
  })
})

describe('determinism', () => {
  it('two runs produce identical ids', () => {
    const run = (): string[] => {
      const sim = new YouTubeSimulator()
      const playlist = sim.createPlaylist()
      return [playlist.id, sim.addItem(playlist.id, 'v').itemId, sim.search('q').videoId]
    }
    expect(run()).toEqual(run())
  })

  it('recorded fixtures still match what the simulator produces', () => {
    // The point of recording them. A hand-maintained fixture drifts from the thing it
    // claims to record, and a consumer then passes against a shape that no longer
    // exists — the exact failure contract tests exist to prevent.
    expect(ERROR_FIXTURES.quotaExceeded.body).toEqual(quotaExceeded().body)
    expect(ERROR_FIXTURES.rateLimited.body).toEqual(rateLimited(30).body)
    expect(ERROR_FIXTURES.rateLimited.retryAfter).toBe(30)
    expect(ERROR_FIXTURES.backendError.retryable).toBe(true)
  })

  it('the 15-song fixture matches a real run', () => {
    const sim = new YouTubeSimulator()
    const playlist = sim.createPlaylist()
    const itemIds = Array.from(
      { length: FIFTEEN_SONG_JOB.trackCount },
      (_, i) => sim.addItem(playlist.id, `vid_${i}`).itemId,
    )
    expect(playlist.id).toBe(FIFTEEN_SONG_JOB.playlistId)
    expect(itemIds).toEqual([...FIFTEEN_SONG_JOB.itemIds])
    expect(sim.state.unitsUsed).toBe(FIFTEEN_SONG_JOB.expectedUnits)
  })
})
