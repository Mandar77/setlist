/**
 * CORE-02 asks for a test that asserts the rate limiter is never exceeded, and that is
 * the only interesting thing to test here — so it is tested against a fake clock rather
 * than a real one.
 *
 * A limiter checked with real timers can only be checked approximately and slowly: ten
 * requests take ten seconds, and the assertion has to allow enough slack for timer jitter
 * that an off-by-a-bit bug fits inside the slack. With the clock injected the same
 * property becomes exact — every gap is >= 1000, not "about a second" — and a thousand
 * requests cost a millisecond, so the test can cover a realistic harvest instead of a
 * token handful.
 *
 * MusicBrainz throttles and then blocks an IP that exceeds one request per second. The
 * cost of getting this wrong is not a slow build; it is the project losing access to a
 * free service it was asked politely to be careful with.
 */

import { describe, expect, it } from 'vitest'

import { RateLimiter, type Clock } from '../src/rate-limit.js'

/** A clock that only moves when something sleeps, so time is whatever the code asked for. */
class FakeClock implements Clock {
  current = 0
  readonly sleeps: number[] = []

  now(): number {
    return this.current
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms)
    this.current += ms
  }

  /** Simulate real work happening between requests. */
  advance(ms: number): void {
    this.current += ms
  }
}

/**
 * Run `count` acquisitions, returning the clock time each turn was granted.
 *
 * The times come from `acquire()` rather than from reading the clock afterwards. Under a
 * fake clock those differ: another caller's `sleep` advances time synchronously, so a
 * continuation can observe a clock that has already moved past its own slot. Asking the
 * limiter when it granted the turn is the only way to measure the thing being asserted.
 */
async function starts(
  limiter: RateLimiter,
  clock: FakeClock,
  count: number,
  workMs = 0,
): Promise<number[]> {
  const at: number[] = []
  for (let i = 0; i < count; i += 1) {
    at.push(await limiter.acquire())
    clock.advance(workMs)
  }
  return at
}

describe('the one-per-second promise', () => {
  it('never starts two requests less than the interval apart', async () => {
    const clock = new FakeClock()
    const limiter = new RateLimiter(1000, clock)

    const at = await starts(limiter, clock, 500)

    const gaps = at.slice(1).map((t, i) => t - at[i]!)
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(1000)
  })

  it('holds even when the requests themselves take no time at all', async () => {
    // The degenerate case, and the one a naive "sleep after each response" limiter gets
    // right by accident while getting the next one wrong.
    const clock = new FakeClock()
    const limiter = new RateLimiter(1000, clock)

    const at = await starts(limiter, clock, 10, 0)

    expect(at).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000])
  })

  it('measures from the start of a request, not the end of it', async () => {
    // A request that took 400ms has already used 400ms of its second. Waiting a further
    // full second would be slower than MusicBrainz asks for — correct, but not what this
    // limiter claims to do, and the difference compounds across a harvest.
    const clock = new FakeClock()
    const limiter = new RateLimiter(1000, clock)

    const at = await starts(limiter, clock, 4, 400)

    expect(at).toEqual([0, 1000, 2000, 3000])
    expect(clock.sleeps).toEqual([600, 600, 600])
  })

  it('does not wait at all when the work already took longer than the interval', async () => {
    const clock = new FakeClock()
    const limiter = new RateLimiter(1000, clock)

    const at = await starts(limiter, clock, 3, 2500)

    expect(at).toEqual([0, 2500, 5000])
    expect(clock.sleeps).toEqual([])
  })

  it('serializes concurrent callers instead of letting them burst', async () => {
    // Two callers acquiring at once is the bug this is built to prevent: both read the
    // same "last start", both compute the same wait, and both begin together — a limiter
    // that permits exactly the burst it exists to stop.
    const clock = new FakeClock()
    const limiter = new RateLimiter(1000, clock)
    const at: number[] = []

    await Promise.all(
      Array.from({ length: 20 }, async () => {
        at.push(await limiter.acquire())
      }),
    )

    const sorted = [...at].sort((a, b) => a - b)
    const gaps = sorted.slice(1).map((t, i) => t - sorted[i]!)
    expect(gaps.every(gap => gap >= 1000)).toBe(true)
    expect(new Set(at).size).toBe(20)
  })

  it('keeps the queue moving after a caller fails', async () => {
    // A rejected acquisition must not deadlock everything queued behind it.
    const clock = new FakeClock()
    const limiter = new RateLimiter(1000, clock)

    const failing = limiter.acquire().then(() => {
      throw new Error('request blew up')
    })
    await expect(failing).rejects.toThrow('request blew up')

    await limiter.acquire()
    expect(clock.now()).toBe(1000)
  })

  it('refuses a nonsensical interval rather than silently not limiting', () => {
    expect(() => new RateLimiter(Number.NaN)).toThrow(RangeError)
    expect(() => new RateLimiter(-1)).toThrow(RangeError)
  })
})

describe('the limiter is actually wired into the client', () => {
  it('spaces real browse calls', async () => {
    // The limiter being correct is worth nothing if the client forgets to call it. This
    // is the join, checked with a fake fetch so no request leaves the machine.
    const clock = new FakeClock()
    const at: number[] = []
    const { MusicBrainzClient } = await import('../src/musicbrainz.js')

    const client = new MusicBrainzClient({
      clock,
      minIntervalMs: 1000,
      fetch: async () => {
        at.push(clock.now())
        return new Response(JSON.stringify({ releases: [], 'release-count': 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    for (let i = 0; i < 5; i += 1) await client.browseReleases('mbid', i, 25)

    expect(at).toEqual([0, 1000, 2000, 3000, 4000])
  })

  it('sends the User-Agent MusicBrainz requires, carrying the repo URL', async () => {
    // Not cosmetic: requests without a descriptive agent and a contact are throttled and
    // then blocked. The contact is the repository rather than a person, because the repo
    // is public and ADR-005 keeps personal addresses out of it.
    const clock = new FakeClock()
    let seen: Record<string, string> = {}
    const { MusicBrainzClient } = await import('../src/musicbrainz.js')

    const client = new MusicBrainzClient({
      clock,
      fetch: async (_url, init) => {
        seen = init.headers
        return new Response('{}', { status: 200 })
      },
    })
    await client.browseReleases('mbid', 0, 25)

    expect(seen['User-Agent']).toMatch(/^setlist-seed-catalog\/[\d.]+ \(\+https:\/\/github\.com\//)
    expect(seen['User-Agent']).not.toMatch(/@/)
  })

  it('raises on an error status instead of parsing the body as data', async () => {
    const clock = new FakeClock()
    const { MusicBrainzClient, MusicBrainzError } = await import('../src/musicbrainz.js')

    const client = new MusicBrainzClient({
      clock,
      fetch: async () => new Response('slow down', { status: 503 }),
    })

    await expect(client.browseReleases('mbid', 0, 25)).rejects.toBeInstanceOf(MusicBrainzError)
  })
})
