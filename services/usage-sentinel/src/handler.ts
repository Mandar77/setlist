/**
 * The Lambda entry point: read each share, publish nothing, trip if needed.
 *
 * `GetMetricStatistics` is the only CloudWatch call made here and it is free.
 * `GetMetricData` is billed per call, as are Logs Insights queries and Cost Explorer —
 * a monitoring loop built on any of them would be a recurring charge whose job is to
 * prevent recurring charges (CLAUDE.md, ADR-005). `sentinel.test.ts` greps this directory
 * to keep it that way.
 */

import {
  CloudWatchClient,
  DescribeAlarmsCommand,
  type DescribeAlarmsCommandOutput,
  GetMetricStatisticsCommand,
} from '@aws-sdk/client-cloudwatch'

import {
  countAlarms,
  readShares,
  type AlarmCensus,
  type AlarmSource,
  type MetricQuery,
  type MetricSource,
  type SentinelResult,
} from './sentinel.js'
import { allowancesFrom, sharesFor } from './shares.js'

const cloudWatch = new CloudWatchClient({})

export const alarmSource: AlarmSource = {
  async countAlarms(): Promise<number> {
    let total = 0
    let token: string | undefined

    // Paginated, because a truncated count reads as "comfortably under the allowance"
    // — the one wrong answer that looks like good news. DescribeAlarms caps a page at
    // 100 and the allowance being watched is 10, so this is one call in practice; the
    // loop is here for the case where it is not.
    do {
      const page: DescribeAlarmsCommandOutput = await cloudWatch.send(
        new DescribeAlarmsCommand({ NextToken: token, MaxRecords: 100 }),
      )
      total += (page.MetricAlarms ?? []).length + (page.CompositeAlarms ?? []).length
      token = page.NextToken
    } while (token !== undefined && token !== '')

    return total
  },
}

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

export async function handler(): Promise<SentinelResult & { alarms: AlarmCensus }> {
  const env = process.env['ENV_NAME']
  const tripPct = Number(process.env['TRIP_PCT'] ?? '85')
  const alarmAllowance = Number(process.env['ALARM_ALLOWANCE'] ?? '0')
  if (env === undefined || env === '') throw new Error('ENV_NAME is not set')
  if (!Number.isFinite(tripPct)) throw new Error(`TRIP_PCT is not a number: ${tripPct}`)
  if (!Number.isFinite(alarmAllowance)) {
    throw new Error(`ALARM_ALLOWANCE is not a number: ${alarmAllowance}`)
  }

  const result = await readShares(
    metricSource,
    sharesFor(env, allowancesFrom(process.env['SHARES'])),
    tripPct,
  )

  const alarms = await countAlarms(alarmSource, alarmAllowance)

  // Deliberately only reports. Engaging the kill switch is the budget alarm's job and
  // this one's recommendation — two independent paths to the same action, rather than
  // one that can be wrong on its own.
  if (result.shouldTrip) console.warn(`usage-sentinel: ${result.reason}`)

  // Reported, never tripped. An eleventh alarm is $0.10/month; disabling an environment
  // over that would be an outage caused by the guard. It is still said out loud, because
  // the alarms this is looking for are ones no template shows and nobody would
  // otherwise count (ADR-013).
  if (alarms.overBy !== null && alarms.overBy > 0) {
    console.warn(
      `usage-sentinel: ${alarms.count} CloudWatch alarms against a free allowance of ` +
        `${alarms.allowance} — ${alarms.overBy} over, at $0.10 each per month. ` +
        'Alarms created by a service at runtime do not appear in any template.',
    )
  }
  if (alarms.unknown) console.warn('usage-sentinel: could not count CloudWatch alarms')

  return { ...result, alarms }
}
