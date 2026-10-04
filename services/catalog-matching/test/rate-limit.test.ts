// The MusicBrainz rate limit (PRD §7.10.6).
//
// This is the test M3-03's done_when singles out: "a test proves the rate limit is never
// exceeded, including under concurrency". It matters more than the usual because
// exceeding MusicBrainz's limit does not return a 429 to back off from — it gets the IP
// blocked, which no retry fixes and which affects a volunteer-run service.
//
// The concurrency case is the one a naive counter-and-timer bucket fails, and it fails
// it in the worst way: rarely, so every test that is not looking for it passes.

import { describe, expect, it } from 'vitest'

import {
  FakeClock,
  MUSICBRAINZ_MIN_INTERVAL_MS,
  TokenBucket,
  USER_AGENT,
} from '../src/rate-limit.js'

describe('the User-Agent MusicBrainz requires', () => {
  it('names the application, a version and a contact', () => {
    expect(USER_AGENT).toMatch(/^setlist\/\d+\.\d+ \(https?:\/\/\S+\)$/)
  })

  it('carries no personal data — the repo URL is the contact', () => {
    // ADR-005: nothing personal in a public repository. A contact email in a committed
    // constant would be exactly that.
    expect(USER_AGENT).not.toMatch(/@/)
  })
})

describe('sequential requests', () => {
  it('are spaced by at least one second', async () => {
    const clock = new FakeClock()
    const bucket = new TokenBucket(MUSICBRAINZ_MIN_INTERVAL_MS, clock)

    const first = await bucket.acquire()
    const pending = bucket.acquire()
    await clock.advance(MUSICBRAINZ_MIN_INTERVAL_MS)
    const second = await pending

    expect(second - first).toBeGreaterThanOrEqual(MUSICBRAINZ_MIN_INTERVAL_MS)
  })

  it('does not delay the very first request', async () => {
    const clock = new FakeClock()
    const bucket = new TokenBucket(MUSICBRAINZ_MIN_INTERVAL_MS, clock)
    expect(await bucket.acquire()).toBe(0)
  })
})

describe('under concurrency', () => {
  it('never issues two departures in the same second, for 20 simultaneous callers', async () => {
    const clock = new FakeClock()
    const bucket = new TokenBucket(MUSICBRAINZ_MIN_INTERVAL_MS, clock)

    // All twenty arrive before any of them can wait — the exact interleaving that
    // defeats a read-decrement counter.
    const pending = Array.from({ length: 20 }, () => bucket.acquire())
    await clock.advance(MUSICBRAINZ_MIN_INTERVAL_MS * 25)
    const slots = await Promise.all(pending)

    expect(slots).toHaveLength(20)
    const sorted = [...slots].sort((a, b) => a - b)
    for (let i = 1; i < sorted.length; i += 1) {
      expect(
        sorted[i]! - sorted[i - 1]!,
        `requests ${i - 1} and ${i} departed ${sorted[i]! - sorted[i - 1]!}ms apart`,
      ).toBeGreaterThanOrEqual(MUSICBRAINZ_MIN_INTERVAL_MS)
    }
  })

  it('gives every caller a distinct slot', async () => {
    const clock = new FakeClock()
    const bucket = new TokenBucket(MUSICBRAINZ_MIN_INTERVAL_MS, clock)
    const pending = Array.from({ length: 10 }, () => bucket.acquire())
    await clock.advance(MUSICBRAINZ_MIN_INTERVAL_MS * 15)
    const slots = await Promise.all(pending)
    expect(new Set(slots).size).toBe(slots.length)
  })

  it('serves callers in arrival order', async () => {
    const clock = new FakeClock()
    const bucket = new TokenBucket(MUSICBRAINZ_MIN_INTERVAL_MS, clock)
    const pending = Array.from({ length: 5 }, () => bucket.acquire())
    await clock.advance(MUSICBRAINZ_MIN_INTERVAL_MS * 10)
    const slots = await Promise.all(pending)
    expect(slots).toEqual([...slots].sort((a, b) => a - b))
  })

  it('counts every grant', async () => {
    const clock = new FakeClock()
    const bucket = new TokenBucket(MUSICBRAINZ_MIN_INTERVAL_MS, clock)
    const pending = Array.from({ length: 7 }, () => bucket.acquire())
    await clock.advance(MUSICBRAINZ_MIN_INTERVAL_MS * 10)
    await Promise.all(pending)
    expect(bucket.count).toBe(7)
  })
})

describe('the test can fail', () => {
  it('a bucket with no interval violates the property this file asserts', async () => {
    // The control. If the assertions above held for any bucket, they would be measuring
    // nothing — so the same property is checked against a deliberately broken one.
    const clock = new FakeClock()
    const unlimited = new TokenBucket(0, clock)
    const slots = await Promise.all(Array.from({ length: 5 }, () => unlimited.acquire()))

    const sorted = [...slots].sort((a, b) => a - b)
    const gaps = sorted.slice(1).map((s, i) => s - sorted[i]!)
    expect(gaps.some(gap => gap < MUSICBRAINZ_MIN_INTERVAL_MS)).toBe(true)
  })
})
