// The usage sentinel: the runtime half of the $0 guarantee.
//
// The most important test in this file is the last one, and it is a grep. The interface
// constrains code that goes through it; nothing stops a future handler from importing an
// SDK client directly and calling `GetMetricData`, which bills per call. So the source
// tree is checked for the banned names as well.

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { readShares, sharePct, type MetricQuery, type MetricSource, type Share } from '../src/index.js'

const QUERY: MetricQuery = {
  namespace: 'AWS/Lambda',
  metricName: 'Invocations',
  dimensions: {},
  startTime: new Date('2026-10-01T00:00:00Z'),
  endTime: new Date('2026-10-04T00:00:00Z'),
}

const share = (over: Partial<Share> = {}): Share => ({
  limit: 'lambda_requests',
  env: 'prod',
  allowance: 1000,
  query: QUERY,
  ...over,
})

const sourceOf = (value: number | null | Error): MetricSource => ({
  getMetricStatistics: async () => {
    if (value instanceof Error) throw value
    return value
  },
})

describe('share arithmetic', () => {
  it('is used over allowance', () => {
    expect(sharePct(50, 200)).toBe(25)
    expect(sharePct(200, 200)).toBe(100)
  })

  it('treats any use of a zero allowance as over', () => {
    // dev is budgeted zero alarms and zero Spotify users. "0% of nothing" would be a
    // pass, and these are exactly the shares where any use at all is the problem.
    expect(sharePct(1, 0)).toBe(Infinity)
    expect(sharePct(0, 0)).toBe(0)
  })
})

describe('tripping', () => {
  it('does not trip below the threshold', () => {
    // The control. Without it a sentinel that tripped on everything would look identical.
    return expect(
      readShares(sourceOf(840), [share()], 85).then(r => r.shouldTrip),
    ).resolves.toBe(false)
  })

  it('trips at the threshold exactly', async () => {
    // At, not above. The gap between the 70% CI gate and 85% here is the room a forecast
    // is allowed to be wrong in; spending the last 15% before acting wastes it.
    const result = await readShares(sourceOf(850), [share()], 85)
    expect(result.shouldTrip).toBe(true)
    expect(result.tripped).toHaveLength(1)
  })

  it('names what tripped and by how much', async () => {
    const result = await readShares(sourceOf(900), [share()], 85)
    expect(result.reason).toMatch(/lambda_requests\/prod at 90\.0%/)
  })

  it('says nothing when nothing tripped', async () => {
    expect((await readShares(sourceOf(10), [share()], 85)).reason).toBeNull()
  })

  it('reports every share, not only the ones that tripped', async () => {
    const result = await readShares(sourceOf(10), [share(), share({ env: 'dev' })], 85)
    expect(result.readings).toHaveLength(2)
  })
})

describe('a metric that cannot be read', () => {
  it('is unknown rather than fine', async () => {
    const result = await readShares(sourceOf(new Error('throttled')), [share()], 85)
    expect(result.unknown).toHaveLength(1)
    expect(result.readings[0]!.used).toBeNull()
    expect(result.readings[0]!.pct).toBeNull()
  })

  it('does not trip the kill switch on its own', async () => {
    // Deliberate, and the opposite of how the lockfile-age check fails closed. There,
    // "cannot establish age" means a supply-chain risk is unverified and the safe answer
    // is to stop. Here, tripping means taking the system down — so a CloudWatch blip
    // would be an outage caused by the guard rather than by the thing it guards.
    const result = await readShares(sourceOf(new Error('throttled')), [share()], 85)
    expect(result.shouldTrip).toBe(false)
  })

  it('is distinguished from a metric that reported zero', async () => {
    // No datapoints means the service was never called; zero means it was called and did
    // nothing. Collapsing them would hide a sentinel that is reading the wrong dimension.
    const none = await readShares(sourceOf(null), [share()], 85)
    expect(none.readings[0]!.used).toBeNull()

    const zero = await readShares(sourceOf(0), [share()], 85)
    expect(zero.readings[0]!.used).toBe(0)
    expect(zero.readings[0]!.pct).toBe(0)
  })
})

describe('the banned APIs', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const srcDir = resolve(here, '..', 'src')

  /** Every TypeScript source file in this service. */
  const sources = readdirSync(srcDir)
    .filter(name => name.endsWith('.ts'))
    .map(name => ({ name, text: readFileSync(join(srcDir, name), 'utf8') }))

  it('has sources to check, so this test cannot pass vacuously', () => {
    expect(sources.length).toBeGreaterThan(0)
  })

  it.each(['GetMetricData', 'StartQuery', 'GetQueryResults', 'GetCostAndUsage'])(
    'never calls %s',
    banned => {
      // All three are billed per call, and a monitoring loop built on them would be a
      // recurring charge whose job is to prevent recurring charges (CLAUDE.md, ADR-005).
      // The interface makes them unexpressible; this catches an SDK client imported
      // around it.
      for (const source of sources) {
        // The doc comment names them on purpose, so only look at what is not a comment.
        const code = source.text
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '')
        expect(code, `${source.name} mentions ${banned}`).not.toContain(banned)
      }
    },
  )

  it('reads only through GetMetricStatistics', () => {
    const code = sources.map(s => s.text).join('\n')
    expect(code).toContain('getMetricStatistics')
  })
})
