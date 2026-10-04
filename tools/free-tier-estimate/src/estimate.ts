/**
 * Projects monthly usage from the usage model and measures it against the budget.
 *
 * The whole job is converting between three different shapes of number without lying
 * about any of them. Volumes are monthly; DynamoDB capacity is per second; YouTube's
 * quota resets daily. Comparing a monthly total to a per-second allowance is not a
 * rounding error, it is three orders of magnitude of false comfort — so the conversion
 * is driven by each limit's declared `basis` and refuses to guess.
 *
 * Nothing numeric lives here. Allowances come from budget.yaml, costs and volumes from
 * usage-model.yaml, and the calendar from that file's `days_per_month`.
 */

import {
  type Budget,
  type EnvName,
  ENV_NAMES,
  type LimitBasis,
  loadBudget,
  shareFor,
} from '../../../infra/lib/config/budget.js'
import { loadUsageModel, type UsageModel } from './model.js'

const SECONDS_PER_DAY = 86_400

export type Scope = 'aws' | 'provider' | 'cloudfront'

export interface Row {
  readonly limit: string
  readonly env: EnvName
  readonly scope: Scope
  readonly basis: LimitBasis
  readonly unit: string
  /** Projected usage, already expressed in the limit's own basis. */
  readonly projected: number
  readonly allowance: number
  /** Percentage of allowance. `Infinity` when something is budgeted zero and used. */
  readonly pct: number
  /** False when no metric meters this limit, so the 0 below means "unknown". */
  readonly modelled: boolean
  /** Which usage-model metrics fed this row. */
  readonly metrics: readonly string[]
  /** The weakest confidence among the operations that contributed. */
  readonly confidence: string
}

/**
 * The threshold a row is judged against.
 *
 * Two numbers, because the allowances are two different kinds of thing (ADR-008). An AWS
 * allowance is elastic: cross it and the meter starts charging, so the 70% gate is
 * headroom against an estimate being wrong. A provider quota is a hard ceiling with no
 * overage — crossing YouTube's returns `quotaExceeded` and the request fails — so there
 * is no bill to hold headroom against, and 30% of a quota that cannot be purchased is
 * just a smaller product.
 *
 * Keyed on `scope` rather than on a per-limit override: a knob per row would let any
 * inconvenient limit be moved one at a time, while a threshold per kind has to be argued
 * once and then applies to every provider quota, including ones added later.
 *
 * `cloudfront` is an AWS allowance and gates at 70% like the rest. Prod's flat-rate plan
 * has no overage either, which makes it look like the provider case, but the plan is
 * something this project chose and could leave — and `estimate.test.ts` pins that, so
 * widening the exception to CloudFront has to be a deliberate edit with a failing test
 * in front of it.
 */
export function gateFor(
  scope: Scope,
  thresholds: { readonly gatePct: number; readonly providerGatePct: number },
): number {
  return scope === 'provider' ? thresholds.providerGatePct : thresholds.gatePct
}

export interface Estimate {
  readonly gatePct: number
  /** The higher threshold provider quotas are judged against. See {@link gateFor}. */
  readonly providerGatePct: number
  readonly tripPct: number
  /** Every row, sorted by percentage of allowance used, descending. */
  readonly rows: readonly Row[]
  /** The row closest to its allowance across every environment and both quota kinds. */
  readonly bindsFirst: Row | undefined
  /** Modelled rows above `gatePct`. Non-empty means the gate fails. */
  readonly breaches: readonly Row[]
  /** Limits nobody meters. Reported, because an unmodelled limit is not a safe one. */
  readonly unmodelled: readonly string[]
  /** Where the written-down forecast and the computed one disagree. */
  readonly planDrift: readonly PlanDrift[]
}

export interface PlanDrift {
  readonly env: EnvName
  readonly what: string
  readonly declared: number
  readonly computed: number
}

/** Monthly total for every metric in one environment, traffic plus baseline. */
function monthlyTotals(
  model: UsageModel,
  env: EnvName,
): Map<string, { total: number; metrics: Set<string>; confidence: string }> {
  const totals = new Map<string, { total: number; metrics: Set<string>; confidence: string }>()

  const add = (metric: string, amount: number, confidence: string): void => {
    const existing = totals.get(metric) ?? { total: 0, metrics: new Set<string>(), confidence }
    existing.total += amount
    existing.metrics.add(metric)
    // "estimated" beats "measured": the report should carry the weakest link, not the
    // most flattering one.
    if (confidence !== 'measured') existing.confidence = confidence
    totals.set(metric, existing)
  }

  for (const [name, occurrences] of Object.entries(model.volumes[env])) {
    const operation = model.operations[name]
    if (operation === undefined) continue // loadUsageModel already rejected this
    for (const [metric, costEach] of Object.entries(operation.metrics)) {
      add(metric, costEach * occurrences, operation.confidence)
    }
  }

  // Baseline is traffic-independent overhead; it is declared, so it counts as measured.
  for (const [metric, amount] of Object.entries(model.baseline[env])) {
    add(metric, amount, 'declared')
  }

  return totals
}

/** Express a monthly total in the limit's own basis. */
function inBasis(monthly: number, basis: LimitBasis, daysPerMonth: number): number {
  switch (basis) {
    case 'monthly':
      return monthly
    case 'per_day':
      return monthly / daysPerMonth
    case 'per_second':
      return monthly / (daysPerMonth * SECONDS_PER_DAY)
    case 'fixed':
      // A standing count cannot be derived from traffic. Reaching here means a meter
      // points at a `fixed` limit, which is a modelling mistake rather than a number
      // to approximate.
      throw new Error(
        'a metric meters a limit with basis `fixed`, which is not derived from volume',
      )
  }
}

const percent = (projected: number, allowance: number): number => {
  if (allowance > 0) return (projected / allowance) * 100
  return projected > 0 ? Infinity : 0
}

export function estimate(
  budget: Budget = loadBudget(),
  model: UsageModel = loadUsageModel(undefined, budget),
): Estimate {
  const rows: Row[] = []
  const planDrift: PlanDrift[] = []
  const metered = new Set<string>()

  for (const env of ENV_NAMES) {
    const totals = monthlyTotals(model, env)

    // Group metrics by the limit they charge, so two metrics hitting one allowance add
    // up instead of each reporting as if it were alone.
    const byLimit = new Map<string, { monthly: number; metrics: Set<string>; confidence: string }>()
    let cloudfrontRequests = 0
    const cloudfrontMetrics = new Set<string>()
    let cloudfrontConfidence = 'measured'

    for (const [metric, totalled] of totals) {
      const meter = model.meters[metric]
      if (meter === undefined) continue // loadUsageModel already rejected this

      if (meter.cloudfront !== undefined) {
        cloudfrontRequests += totalled.total
        cloudfrontMetrics.add(metric)
        if (totalled.confidence !== 'measured') cloudfrontConfidence = totalled.confidence
        continue
      }

      const name = meter.limit as string
      metered.add(name)
      const existing = byLimit.get(name) ?? {
        monthly: 0,
        metrics: new Set<string>(),
        confidence: totalled.confidence,
      }
      existing.monthly += totalled.total
      for (const m of totalled.metrics) existing.metrics.add(m)
      if (totalled.confidence !== 'measured') existing.confidence = totalled.confidence
      byLimit.set(name, existing)
    }

    for (const [name, charged] of byLimit) {
      const limit = budget.limits[name] ?? budget.providerLimits[name]
      if (limit === undefined) continue // loadUsageModel already rejected this
      const projected = inBasis(charged.monthly, limit.basis, model.daysPerMonth)
      const allowance = shareFor(name, env, budget)
      rows.push({
        limit: name,
        env,
        scope: budget.limits[name] === undefined ? 'provider' : 'aws',
        basis: limit.basis,
        unit: limit.unit ?? '',
        projected,
        allowance,
        pct: percent(projected, allowance),
        modelled: true,
        metrics: [...charged.metrics].sort(),
        confidence: charged.confidence,
      })
    }

    // CloudFront, measured against whichever ceiling this environment actually has:
    // prod's flat-rate inclusion, or the shared always-free allowance.
    const cf = budget.cloudfront[env]
    const allowance = cf.requests ?? budget.cloudfront.always_free_requests
    rows.push({
      limit: 'cloudfront_requests',
      env,
      scope: 'cloudfront',
      basis: 'monthly',
      unit: `requests (${cf.plan})`,
      projected: cloudfrontRequests,
      allowance,
      pct: percent(cloudfrontRequests, allowance),
      modelled: cloudfrontMetrics.size > 0,
      metrics: [...cloudfrontMetrics].sort(),
      confidence: cloudfrontConfidence,
    })

    // `planned_requests` is a forecast written down when the plan was chosen. If the
    // usage model now implies something else, one of the two is stale — and silently
    // trusting the friendlier number is how a plan gets outgrown unnoticed.
    if (cloudfrontRequests > cf.planned_requests) {
      planDrift.push({
        env,
        what: 'cloudfront planned_requests',
        declared: cf.planned_requests,
        computed: cloudfrontRequests,
      })
    }
  }

  rows.sort((a, b) => b.pct - a.pct || a.limit.localeCompare(b.limit))

  const allLimits = [...Object.keys(budget.limits), ...Object.keys(budget.providerLimits)]
  const unmodelled = allLimits.filter(name => !metered.has(name)).sort()

  const modelledRows = rows.filter(row => row.modelled)

  return {
    gatePct: budget.gatePct,
    providerGatePct: budget.providerGatePct,
    tripPct: budget.tripPct,
    rows,
    bindsFirst: modelledRows[0],
    breaches: modelledRows.filter(row => row.pct > gateFor(row.scope, budget)),
    unmodelled,
    planDrift,
  }
}
