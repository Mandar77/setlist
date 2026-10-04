/**
 * Which shares the sentinel watches, and which metric answers for each.
 *
 * The allowances are passed in rather than read from `budget.yaml` at runtime. The first
 * version bundled a JSON copy of the budget into the function and read it on every
 * invocation, which meant a bundling hook shelling out to a YAML parser — and that broke
 * immediately, because pnpm does not hoist `yaml` to the workspace root and the generated
 * command had Windows paths in it. The numbers are four integers that are known at synth
 * time; passing them as data is smaller, has no file to find, and keeps `budget.yaml` the
 * single source without making the function parse it.
 *
 * Only the limits a free vended metric can actually answer are listed. The rest are not
 * quietly treated as zero: `make estimate` already reports them as "not modelled", and a
 * sentinel that silently watched nothing would be worse than one that watches four things
 * and says which.
 */

import type { MetricQuery, Share } from './sentinel.js'

/** A month-to-date window, which is the period every monthly allowance resets on. */
export function monthToDate(now: Date): { startTime: Date; endTime: Date } {
  const startTime = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  return { startTime, endTime: now }
}

/**
 * The limits with a free vended metric behind them.
 *
 * Each entry pairs a budget limit with the CloudWatch metric that sums to the same thing.
 * That pairing is the part that can be wrong in a way nothing else would catch — reading
 * `Invocations` against a GB-seconds allowance would report 0.3% forever and look fine.
 */
export const WATCHED: readonly {
  readonly limit: string
  readonly namespace: string
  readonly metricName: string
}[] = [
  { limit: 'lambda_requests', namespace: 'AWS/Lambda', metricName: 'Invocations' },
  { limit: 'sns_publishes', namespace: 'AWS/SNS', metricName: 'NumberOfMessagesPublished' },
  { limit: 'sqs_requests', namespace: 'AWS/SQS', metricName: 'NumberOfMessagesReceived' },
  { limit: 'cloudfront_requests', namespace: 'AWS/CloudFront', metricName: 'Requests' },
]

export function sharesFor(
  env: string,
  allowances: Readonly<Record<string, number>>,
  now: Date = new Date(),
): readonly Share[] {
  const window = monthToDate(now)

  return WATCHED.flatMap(watched => {
    const allowance = allowances[watched.limit]
    // A limit with no allowance for this environment is skipped rather than defaulted to
    // zero: zero would trip immediately and permanently, which is a guard that cries
    // wolf until somebody turns it off.
    if (allowance === undefined) return []
    const query: MetricQuery = {
      namespace: watched.namespace,
      metricName: watched.metricName,
      dimensions: {},
      startTime: window.startTime,
      endTime: window.endTime,
    }
    return [{ limit: watched.limit, env, allowance, query }]
  })
}

/** Parse the `SHARES` environment variable the stack sets. */
export function allowancesFrom(raw: string | undefined): Readonly<Record<string, number>> {
  if (raw === undefined || raw.trim() === '') throw new Error('SHARES is not set')
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) throw new TypeError('SHARES is not an object')

  const allowances: Record<string, number> = {}
  for (const [limit, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`SHARES.${limit} must be a number, got ${String(value)}`)
    }
    allowances[limit] = value
  }
  return allowances
}
