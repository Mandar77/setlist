/**
 * Loads `infra/free-tier/usage-model.yaml` and checks it against the budget.
 *
 * The validation here is the point of the file. A usage model is a forecast, and a
 * forecast with a hole in it does not look wrong — it looks like headroom. So:
 *
 *   - an operation carrying a metric with no meter is an error, not a zero
 *   - a meter naming a limit that does not exist in budget.yaml is an error
 *   - an environment in budget.yaml with no volumes is an error
 *
 * Each of those would otherwise under-report, which is the only direction that costs
 * money.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import {
  type Budget,
  type EnvName,
  ENV_NAMES,
  loadBudget,
} from '../../../infra/lib/config/budget.js'

const HERE = dirname(fileURLToPath(import.meta.url))
export const USAGE_MODEL_PATH = join(
  HERE,
  '..',
  '..',
  '..',
  'infra',
  'free-tier',
  'usage-model.yaml',
)

/** Where a metric's consumption is counted. Exactly one of these is set. */
export interface Meter {
  /** An entry in budget.yaml `limits` or `provider_limits`. */
  readonly limit?: string
  /** A field of the budget's `cloudfront` block, which is not split like the rest. */
  readonly cloudfront?: string
}

export interface Operation {
  readonly description: string
  /** Metric name -> cost per occurrence. Every key must have a meter. */
  readonly metrics: Readonly<Record<string, number>>
  /** `measured` or `estimated`; an estimate surviving to GA is a bill waiting. */
  readonly confidence: string
  readonly note?: string
}

export interface UsageModel {
  readonly version: number
  readonly daysPerMonth: number
  readonly meters: Readonly<Record<string, Meter>>
  readonly operations: Readonly<Record<string, Operation>>
  /** env -> operation name -> occurrences per month. */
  readonly volumes: Readonly<Record<EnvName, Readonly<Record<string, number>>>>
  /** env -> metric name -> fixed monthly amount, independent of traffic. */
  readonly baseline: Readonly<Record<EnvName, Readonly<Record<string, number>>>>
}

/** Keys of an operation block that describe it rather than cost anything. */
const NON_METRIC_KEYS = new Set(['description', 'confidence', 'note'])

interface RawOperation {
  description?: string
  confidence?: string
  note?: string
  [metric: string]: unknown
}

interface RawModel {
  version: number
  days_per_month: number
  meters: Record<string, Meter>
  operations: Record<string, RawOperation>
  volumes: Record<string, Record<string, number>>
  baseline: Record<string, Record<string, number>>
}

export function loadUsageModel(
  path: string = USAGE_MODEL_PATH,
  budget: Budget = loadBudget(),
): UsageModel {
  const raw = parse(readFileSync(path, 'utf8')) as RawModel

  if (typeof raw.days_per_month !== 'number' || raw.days_per_month <= 0) {
    throw new Error("usage-model.yaml: 'days_per_month' must be a positive number")
  }
  if (raw.meters === undefined || Object.keys(raw.meters).length === 0) {
    throw new Error('usage-model.yaml: no meters defined, so nothing would be counted')
  }

  // Every meter must point at something real. A meter naming a limit that was renamed
  // in budget.yaml would quietly stop counting.
  const knownLimits = new Set([
    ...Object.keys(budget.limits),
    ...Object.keys(budget.providerLimits),
  ])
  for (const [metric, meter] of Object.entries(raw.meters)) {
    const targets = [meter.limit, meter.cloudfront].filter(t => t !== undefined)
    if (targets.length !== 1) {
      throw new Error(
        `usage-model.yaml: meter '${metric}' must name exactly one of limit or cloudfront`,
      )
    }
    if (meter.limit !== undefined && !knownLimits.has(meter.limit)) {
      throw new Error(
        `usage-model.yaml: meter '${metric}' charges limit '${meter.limit}', which ` +
          `budget.yaml does not define. Known: ${[...knownLimits].sort().join(', ')}`,
      )
    }
  }

  const operations: Record<string, Operation> = {}
  for (const [name, rawOp] of Object.entries(raw.operations ?? {})) {
    const metrics: Record<string, number> = {}
    for (const [key, value] of Object.entries(rawOp)) {
      if (NON_METRIC_KEYS.has(key)) continue
      if (typeof value !== 'number') {
        throw new Error(`usage-model.yaml: ${name}.${key} must be a number, got '${String(value)}'`)
      }
      if (raw.meters[key] === undefined) {
        throw new Error(
          `usage-model.yaml: operation '${name}' costs '${key}', which has no meter. ` +
            'An unmetered cost is counted as zero, which reads as headroom — add it to ' +
            '`meters` or remove it.',
        )
      }
      metrics[key] = value
    }
    operations[name] = {
      description: rawOp.description ?? name,
      metrics,
      confidence: rawOp.confidence ?? 'unstated',
      ...(rawOp.note === undefined ? {} : { note: rawOp.note }),
    }
  }

  // Volumes and baseline must cover every environment the budget splits across;
  // a missing one would simply not be reported, and an unreported environment is an
  // unguarded one.
  for (const section of ['volumes', 'baseline'] as const) {
    for (const env of ENV_NAMES) {
      if (raw[section]?.[env] === undefined) {
        throw new Error(`usage-model.yaml: '${section}' has no entry for '${env}'`)
      }
    }
  }
  for (const [env, byOperation] of Object.entries(raw.volumes)) {
    for (const name of Object.keys(byOperation)) {
      if (operations[name] === undefined) {
        throw new Error(`usage-model.yaml: volumes.${env} references unknown operation '${name}'`)
      }
    }
  }

  return {
    version: raw.version,
    daysPerMonth: raw.days_per_month,
    meters: raw.meters,
    operations,
    volumes: raw.volumes as UsageModel['volumes'],
    baseline: raw.baseline as UsageModel['baseline'],
  }
}
