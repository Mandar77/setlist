/**
 * The runtime half of the cost guarantee: watch the shares, trip before the bill.
 *
 * `make estimate` is a forecast checked in CI against numbers somebody wrote down. This
 * is the same arithmetic against what actually happened, run on a schedule, and it fires
 * the kill switch at `trip_pct` (85%) rather than the 70% CI gate — the gap between the
 * two is the room a forecast is allowed to be wrong in.
 *
 * ## Free metrics only, and the interface is the enforcement
 *
 * CloudWatch bills per call for `GetMetricData` and for every Logs Insights query, and
 * Cost Explorer bills $0.01 per request. A monitoring loop built on those would be a
 * recurring charge whose whole job is to prevent recurring charges — which is why
 * CLAUDE.md bans all three outright.
 *
 * {@link MetricSource} therefore exposes exactly one read: `getMetricStatistics`, which
 * is free. There is no method here that could become a `GetMetricData` call, so reaching
 * for one means adding a method and explaining why. `sentinel.test.ts` additionally greps
 * this directory for the banned names, because an interface only constrains the code that
 * goes through it.
 *
 * ## Vended metrics only
 *
 * Every metric read here is one AWS publishes for free as a side effect of the service
 * running — Lambda invocations, DynamoDB consumed capacity, SNS publishes. Nothing here
 * puts a custom metric: the first ten are free per account and the eleventh is $0.30 a
 * month, and a sentinel that consumed the custom-metric allowance to watch the budget
 * would be spending the thing it guards.
 */

/** A free CloudWatch read. Deliberately the only one. */
export interface MetricSource {
  /**
   * `GetMetricStatistics` — free, unlike `GetMetricData`.
   *
   * Returns the summed value over the period, or `null` when the metric has no
   * datapoints, which is different from zero: a metric with no data means the service
   * was never called, while zero means it was called and did nothing.
   */
  getMetricStatistics(query: MetricQuery): Promise<number | null>
}

export interface MetricQuery {
  readonly namespace: string
  readonly metricName: string
  readonly dimensions: Readonly<Record<string, string>>
  readonly startTime: Date
  readonly endTime: Date
}

/** One limit's share, as the budget splits it. */
export interface Share {
  readonly limit: string
  readonly env: string
  readonly allowance: number
  readonly query: MetricQuery
}

export interface Reading {
  readonly limit: string
  readonly env: string
  readonly allowance: number
  /** Null when the metric reported no datapoints at all. */
  readonly used: number | null
  /** `used / allowance` as a percentage, or null when unknown. */
  readonly pct: number | null
  /** True when the share is at or above `tripPct`. */
  readonly tripped: boolean
  /** True when the metric could not be read, so the reading proves nothing. */
  readonly unknown: boolean
}

export interface SentinelResult {
  readonly readings: readonly Reading[]
  readonly tripped: readonly Reading[]
  readonly unknown: readonly Reading[]
  /** Whether the kill switch should be engaged. */
  readonly shouldTrip: boolean
  /** One line naming why, for the kill switch's audit record. */
  readonly reason: string | null
}

/**
 * Percentage of an allowance, with a zero allowance treated as already over.
 *
 * "0% of nothing" would be a pass, and the environments budgeted zero of something are
 * precisely the ones where any use at all is the problem.
 */
export function sharePct(used: number, allowance: number): number {
  if (allowance <= 0) return used > 0 ? Infinity : 0
  return (used / allowance) * 100
}

export async function readShares(
  source: MetricSource,
  shares: readonly Share[],
  tripPct: number,
): Promise<SentinelResult> {
  const readings: Reading[] = []

  for (const share of shares) {
    let used: number | null = null
    let unknown = false
    try {
      used = await source.getMetricStatistics(share.query)
    } catch {
      // A metric that cannot be read is NOT a metric that is fine. Recorded as unknown
      // so it is visible, and deliberately not counted as a trip: firing the kill switch
      // because CloudWatch had a bad minute would be an outage caused by the guard.
      unknown = true
    }

    const pct = used === null ? null : sharePct(used, share.allowance)
    readings.push({
      limit: share.limit,
      env: share.env,
      allowance: share.allowance,
      used,
      pct,
      tripped: pct !== null && pct >= tripPct,
      unknown,
    })
  }

  const tripped = readings.filter(reading => reading.tripped)
  const unknownReadings = readings.filter(reading => reading.unknown)

  return {
    readings,
    tripped,
    unknown: unknownReadings,
    shouldTrip: tripped.length > 0,
    reason:
      tripped.length === 0
        ? null
        : `${tripped.length} share(s) at or above ${tripPct}%: ` +
          tripped
            .map(r => `${r.limit}/${r.env} at ${r.pct === null ? '?' : r.pct.toFixed(1)}%`)
            .join(', '),
  }
}
