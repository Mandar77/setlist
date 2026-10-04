/**
 * The Lambda entry point.
 *
 * Thin on purpose: read config, build the deps, run the pure function. Everything worth
 * testing is in `kill-switch.ts` and is tested without AWS.
 *
 * The reason is taken from whatever invoked it — an SNS message from the budget alarm, or
 * the usage sentinel — and lands in the audit record. "Budget alarm" and "sentinel: lambda
 * GB-s at 87%" are very different incidents and an operator should not have to guess
 * which one happened.
 */

import { auditSink, cloudFrontControl, lambdaControl, schedulerControl } from './aws.js'
import { engageKillSwitch, type KillRecord } from './kill-switch.js'

/** What an SNS-delivered invocation looks like, narrowed to what is read. */
interface SnsEvent {
  readonly Records?: readonly { readonly Sns?: { readonly Message?: string } }[]
}

export function reasonFrom(event: unknown): string {
  const record = (event as SnsEvent | undefined)?.Records?.[0]?.Sns?.Message
  if (typeof record === 'string' && record.trim() !== '') return record.slice(0, 1024)
  if (typeof event === 'object' && event !== null && 'reason' in event) {
    const reason = (event as { reason: unknown }).reason
    if (typeof reason === 'string' && reason.trim() !== '') return reason.slice(0, 1024)
  }
  // Never empty. A record that does not say why is a record that explains nothing six
  // months later, and "unspecified" is at least honest about it.
  return 'unspecified'
}

export async function handler(event: unknown): Promise<KillRecord> {
  const tableName = process.env['TABLE_NAME']
  if (tableName === undefined || tableName === '') {
    throw new Error('TABLE_NAME is not set; the kill switch cannot write its audit record')
  }

  return engageKillSwitch(
    {
      lambda: lambdaControl,
      scheduler: schedulerControl,
      cloudfront: cloudFrontControl,
      audit: auditSink(tableName),
      now: () => new Date(),
    },
    { reason: reasonFrom(event) },
  )
}
