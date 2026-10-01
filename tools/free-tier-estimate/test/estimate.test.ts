/**
 * Tests for the free-tier gate.
 *
 * Split deliberately in two:
 *
 *   - **Arithmetic** is checked against the real budget.yaml and usage-model.yaml,
 *     because the PED states these numbers explicitly and a drift from them is the
 *     thing worth catching (800 units a playlist; 7,000/day is 8 playlists).
 *   - **Gate behaviour** is checked against synthetic budgets, because asserting "prod
 *     is at 95.2%" against live data would turn every legitimate budget change into a
 *     test failure, and the pressure would be to edit the test.
 *
 * The conversion tests are the ones that matter most. Comparing a monthly total to a
 * per-second allowance under-reports by a factor of 2.6 million, and under-reporting
 * is the only direction that costs money.
 */

import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Budget } from '../../../infra/lib/config/budget.js'
import { loadBudget, shareFor } from '../../../infra/lib/config/budget.js'
import { loadUsageModel } from '../src/model.js'
import { estimate } from '../src/estimate.js'
import { toMarkdown } from '../src/report.js'

const budget = loadBudget()
const model = loadUsageModel(undefined, budget)

describe('the PED arithmetic, exactly', () => {
  it('a 15-song playlist costs 50 + 15 * 50 = 800 YouTube units', () => {
    const job = model.operations['playlist_job_15_songs']
    expect(job, 'the 15-song playlist operation is the PED reference case').toBeDefined()
    // 50 for playlists.insert, 50 per playlistItems.insert.
    expect(job!.metrics['youtube_units']).toBe(50 + 15 * 50)
    expect(job!.metrics['youtube_units']).toBe(800)
  })

  it("prod's 7,000 units/day is 8 whole playlists a day", () => {
    const unitsPerDay = shareFor('youtube_units_per_day', 'prod', budget)
    const perPlaylist = model.operations['playlist_job_15_songs']!.metrics['youtube_units']!

    expect(unitsPerDay).toBe(7000)
    expect(Math.floor(unitsPerDay / perPlaylist)).toBe(8)
  })

  it('YouTube binds before anything AWS, which is the PED’s whole premise', () => {
    // If this ever stops being true, the architecture is being optimised against the
    // wrong constraint and PED S10.8 needs revisiting — not this test.
    const worstBy = (scope: string): number =>
      Math.max(
        ...estimate(budget, model)
          .rows.filter(r => r.scope === scope)
          .map(r => r.pct),
      )

    expect(worstBy('provider')).toBeGreaterThan(worstBy('aws'))
  })

  it('a quota that resets daily is compared per day, not per month', () => {
    const prod = estimate(budget, model).rows.find(
      r => r.limit === 'youtube_units_per_day' && r.env === 'prod',
    )
    const monthlyJobs = model.volumes.prod['playlist_job_15_songs']!
    const perPlaylist = model.operations['playlist_job_15_songs']!.metrics['youtube_units']!

    expect(prod!.basis).toBe('per_day')
    expect(prod!.projected).toBeCloseTo((monthlyJobs * perPlaylist) / model.daysPerMonth, 6)
  })
})

describe('the PED S10.8 bindings', () => {
  it('Lambda GB-seconds come from the per-operation costs, not a round number', () => {
    const prod = estimate(budget, model).rows.find(
      r => r.limit === 'lambda_gb_seconds' && r.env === 'prod',
    )

    // Recomputed here from the model rather than copied from the report: a test that
    // restates the tool's output agrees with it by construction.
    let expected = 0
    for (const [name, count] of Object.entries(model.volumes.prod)) {
      expected += (model.operations[name]!.metrics['lambda_gb_seconds'] ?? 0) * count
    }

    expect(prod!.basis).toBe('monthly')
    expect(prod!.projected).toBeCloseTo(expected, 6)
    // The server-side OCR path dominates it; if that ever stops being true the 12 GB-s
    // per page gate in PED S10.8 has stopped being the thing to watch.
    const ocr =
      model.operations['server_ocr_page']!.metrics['lambda_gb_seconds']! *
      model.volumes.prod['server_ocr_page']!
    expect(ocr / expected).toBeGreaterThan(0.5)
  })

  it('CloudFront is measured against the plan each environment is actually on', () => {
    const rows = estimate(budget, model).rows.filter(r => r.scope === 'cloudfront')
    const prod = rows.find(r => r.env === 'prod')!
    const dev = rows.find(r => r.env === 'dev')!

    // prod's flat-rate inclusion replaces the always-free allowance; measuring prod
    // against the shared 10M would overstate its headroom tenfold.
    expect(prod.allowance).toBe(budget.cloudfront.prod.requests)
    expect(dev.allowance).toBe(budget.cloudfront.always_free_requests)
    expect(prod.allowance).toBeLessThan(dev.allowance)
  })

  it('reports where the written-down forecast and the model disagree', () => {
    // planned_requests was chosen when the plan was; the model has moved. Surfacing it
    // is the point — silently trusting the friendlier number is how a plan gets
    // outgrown unnoticed.
    const drift = estimate(budget, model).planDrift
    for (const entry of drift) {
      expect(entry.computed).toBeGreaterThan(entry.declared)
    }
  })
})

describe('unit conversion', () => {
  it('a per-second allowance is not compared against a monthly total', () => {
    const prod = estimate(budget, model).rows.find(
      r => r.limit === 'dynamodb_wcu' && r.env === 'prod',
    )!
    let monthlyOps = 0
    for (const [name, count] of Object.entries(model.volumes.prod)) {
      monthlyOps += (model.operations[name]!.metrics['dynamodb_wcu_ops'] ?? 0) * count
    }

    expect(prod.basis).toBe('per_second')
    expect(prod.projected).toBeCloseTo(monthlyOps / (model.daysPerMonth * 86400), 9)
    // The guard against the bug this exists to prevent: the monthly figure would be
    // six orders of magnitude larger and would have sailed through the gate.
    expect(prod.projected).toBeLessThan(monthlyOps)
  })

  it('refuses a basis it does not recognise rather than defaulting to monthly', () => {
    // `per_secnod` silently meaning "monthly" is how DynamoDB capacity would come to
    // look infinitely spacious.
    expect(() => loadBudget(fixturePath('bad-basis.yaml'))).toThrow(/basis/)
  })
})

/** A budget built in memory, so gate behaviour is tested without touching real data. */
function syntheticBudget(share: number): Budget {
  return {
    ...budget,
    gatePct: 70,
    limits: {
      lambda_requests: {
        total: share * 4,
        unit: 'requests',
        basis: 'monthly',
        split: { prod: share, stage: share, dev: share, reserve: share },
      },
    },
    providerLimits: {},
  } as Budget
}

describe('the gate', () => {
  const oneLimitModel = (perOperation: number) => ({
    ...model,
    meters: { lambda_requests: { limit: 'lambda_requests' } },
    operations: {
      only: {
        description: 'only',
        metrics: { lambda_requests: perOperation },
        confidence: 'measured',
      },
    },
    volumes: { prod: { only: 1 }, stage: { only: 1 }, dev: { only: 1 } } as never,
    baseline: { prod: {}, stage: {}, dev: {} } as never,
  })

  it('passes under the gate', () => {
    // 69 of 100 is under 70. The control: without it, a gate that fails everything
    // would look identical to one that works.
    const result = estimate(syntheticBudget(100), oneLimitModel(69))
    expect(result.breaches).toEqual([])
  })

  it('fails above the gate', () => {
    const result = estimate(syntheticBudget(100), oneLimitModel(71))
    expect(result.breaches).toHaveLength(3)
    expect(result.breaches[0]!.limit).toBe('lambda_requests')
  })

  it('does not fail exactly at the gate', () => {
    expect(estimate(syntheticBudget(100), oneLimitModel(70)).breaches).toEqual([])
  })

  it('treats using anything from a zero allowance as over', () => {
    // dev is budgeted zero alarms and zero Spotify users; "0% of nothing" would be a
    // pass, which it must not be.
    const result = estimate(syntheticBudget(0), oneLimitModel(1))
    expect(result.breaches.length).toBeGreaterThan(0)
    expect(result.breaches[0]!.pct).toBe(Infinity)
  })

  it('names the limit that binds first across AWS and provider quotas together', () => {
    const result = estimate(budget, model)
    const worst = Math.max(...result.rows.filter(r => r.modelled).map(r => r.pct))
    expect(result.bindsFirst!.pct).toBe(worst)
  })
})

describe('the model refuses to under-report', () => {
  it('rejects an operation whose cost nobody meters', () => {
    // An unmetered cost counts as zero, and zero reads as headroom.
    expect(() => loadUsageModel(fixturePath('unmetered-cost.yaml'), budget)).toThrow(/no meter/)
  })

  it('rejects a meter pointing at a limit budget.yaml does not define', () => {
    expect(() => loadUsageModel(fixturePath('unknown-limit.yaml'), budget)).toThrow(
      /does not define/,
    )
  })

  it('rejects a model missing an environment', () => {
    expect(() => loadUsageModel(fixturePath('missing-env.yaml'), budget)).toThrow(/no entry for/)
  })

  it('accepts the real model, which is the control for all three', () => {
    expect(() => loadUsageModel(undefined, budget)).not.toThrow()
  })

  it('lists limits nobody meters instead of showing them at zero', () => {
    const result = estimate(budget, model)
    expect(result.unmodelled.length).toBeGreaterThan(0)
    // Whatever is unmodelled must not also appear as a modelled row claiming 0%.
    for (const name of result.unmodelled) {
      expect(result.rows.find(r => r.limit === name && r.modelled)).toBeUndefined()
    }
  })
})

describe('the report', () => {
  it('is markdown sorted by share of allowance, worst first', () => {
    const result = estimate(budget, model)
    const markdown = toMarkdown(result)

    expect(markdown).toContain('| --- |')
    expect(markdown).toContain('Binds first:')

    const pcts = result.rows.map(r => r.pct)
    expect([...pcts].sort((a, b) => b - a)).toEqual(pcts)

    // The first data row of the table must be the binding limit, since that is the
    // only question anyone asks of this table.
    const firstRow = markdown.split('\n').find(line => line.startsWith('| ') && line.includes('`'))
    expect(firstRow).toContain(result.rows[0]!.limit)
  })

  it('names every breach, so the comment is actionable without rerunning it', () => {
    const result = estimate(budget, model)
    const markdown = toMarkdown(result)
    for (const breach of result.breaches) {
      expect(markdown).toContain(breach.limit)
      expect(markdown).toContain(breach.env)
    }
  })
})

/** Absolute path to a fixture, with the leading slash Windows drive letters pick up. */
function fixturePath(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
}
