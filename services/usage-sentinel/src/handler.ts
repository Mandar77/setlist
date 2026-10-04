/**
 * The Lambda entry point: read each share, publish nothing, trip if needed.
 *
 * `GetMetricStatistics` is the only CloudWatch call made here and it is free.
 * `GetMetricData` is billed per call, as are Logs Insights queries and Cost Explorer —
 * a monitoring loop built on any of them would be a recurring charge whose job is to
 * prevent recurring charges (CLAUDE.md, ADR-005). `sentinel.test.ts` greps this directory
 * to keep it that way.
 */

import { CloudWatchClient, GetMetricStatisticsCommand } from '@aws-sdk/client-cloudwatch'

import { readShares, type MetricQuery, type MetricSource, type SentinelResult } from './sentinel.js'
import { allowancesFrom, sharesFor } from './shares.js'

const cloudWatch = new CloudWatchClient({})

export const metricSource: MetricSource = {
  async getMetricStatistics(query: MetricQuery): Promise<number | null> {
    const response = await cloudWatch.send(
      new GetMetricStatisticsCommand({
        Namespace: query.namespace,
        MetricName: query.metricName,
        Dimensions: Object.entries(query.dimensions).map(([Name, Value]) => ({ Name, Value })),
        StartTime: query.startTime,
        EndTime: query.endTime,
        // One datapoint covering the whole window. A shorter period would return many
        // points to sum client-side for the same answer and the same price.
        Period: Math.max(
          60,
          Math.ceil((query.endTime.getTime() - query.startTime.getTime()) / 1000),
        ),
        Statistics: ['Sum'],
      }),
    )
    const points = response.Datapoints ?? []
    // No datapoints is not zero: it means the service was never called in the window.
    if (points.length === 0) return null
    return points.reduce((total, point) => total + (point.Sum ?? 0), 0)
  },
}

export async function handler(): Promise<SentinelResult> {
  const env = process.env['ENV_NAME']
  const tripPct = Number(process.env['TRIP_PCT'] ?? '85')
  if (env === undefined || env === '') throw new Error('ENV_NAME is not set')
  if (!Number.isFinite(tripPct)) throw new Error(`TRIP_PCT is not a number: ${tripPct}`)

  const result = await readShares(
    metricSource,
    sharesFor(env, allowancesFrom(process.env['SHARES'])),
    tripPct,
  )

  // Deliberately only reports. Engaging the kill switch is the budget alarm's job and
  // this one's recommendation — two independent paths to the same action, rather than
  // one that can be wrong on its own.
  if (result.shouldTrip) console.warn(`usage-sentinel: ${result.reason}`)
  return result
}
