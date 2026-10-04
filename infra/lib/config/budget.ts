/**
 * Reads `infra/free-tier/budget.yaml`, the single source of truth for every free-tier
 * allowance and its per-environment share.
 *
 * Deliberately loaded rather than duplicated. The same file is read by the CI
 * estimator and, at runtime, by the usage sentinel. If the stacks carried their own
 * copy of "prod gets 10 WCU", the number CI gates on and the number actually
 * provisioned could drift apart silently — and the first symptom would be a bill.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const HERE = dirname(fileURLToPath(import.meta.url))
export const BUDGET_PATH = join(HERE, '..', '..', 'free-tier', 'budget.yaml')

export type EnvName = 'dev' | 'stage' | 'prod'
export const ENV_NAMES: readonly EnvName[] = ['dev', 'stage', 'prod'] as const

/**
 * What an allowance's number means.
 *
 * Not decoration: 20 million monthly DynamoDB writes against a 25 WCU allowance is
 * either 8 WCU (correct) or 0.00008% of a monthly total (nonsense that reads as
 * headroom). The estimator cannot tell which from the number alone.
 */
export type LimitBasis = 'monthly' | 'per_day' | 'per_second' | 'fixed'

export const LIMIT_BASES: readonly LimitBasis[] = [
  'monthly',
  'per_day',
  'per_second',
  'fixed',
] as const

/** One allowance and how it is divided. `reserve` is unallocated headroom. */
export interface Limit {
  readonly total: number
  readonly unit?: string
  /** Defaults to `monthly`, which is what most always-free allowances are. */
  readonly basis: LimitBasis
  readonly note?: string
  readonly split: Readonly<Record<string, number>>
}

export interface Budget {
  readonly version: number
  readonly accountType: string
  readonly region: string
  /** CI fails above this share of any AWS allowance. */
  readonly gatePct: number
  /**
   * The threshold provider quotas are judged against instead (ADR-008).
   *
   * Higher because the risk is different, not because the limit is less important: an
   * AWS allowance that is exceeded bills, while a provider quota that is exceeded simply
   * refuses the request. There is no overage to hold 30% back against.
   */
  readonly providerGatePct: number
  /** The runtime sentinel throttles above this share. */
  readonly tripPct: number
  readonly limits: Readonly<Record<string, Limit>>
  readonly providerLimits: Readonly<Record<string, Limit>>
  /**
   * CloudFront, which is not split like the others: prod runs the flat-rate Free plan
   * with its own inclusion, dev and stage draw on the shared always-free allowance.
   */
  readonly cloudfront: CloudFrontBudget
  /** Resource descriptions that must never appear in a synthesized template. */
  readonly neverUse: readonly string[]
}

export interface CloudFrontEnv {
  readonly plan: string
  /** Requests included in this environment's plan; absent on pay-as-you-go. */
  readonly requests?: number
  readonly data_transfer_gb?: number
  /** The forecast written down when the plan was chosen. */
  readonly planned_requests: number
  readonly note?: string
}

export interface CloudFrontBudget {
  readonly always_free_requests: number
  readonly always_free_data_transfer_gb: number
  readonly prod: CloudFrontEnv
  readonly stage: CloudFrontEnv
  readonly dev: CloudFrontEnv
}

/** A limit as written in YAML, before `basis` is defaulted. */
type RawLimit = Omit<Limit, 'basis'> & { basis?: string }

interface RawBudget {
  version: number
  account_type: string
  region: string
  gate_pct: number
  provider_gate_pct: number
  trip_pct: number
  limits: Record<string, RawLimit>
  provider_limits: Record<string, RawLimit>
  cloudfront: CloudFrontBudget
  never_use: string[]
}

/**
 * Apply the `monthly` default and reject anything unrecognised.
 *
 * A typo'd basis must not fall back to the default: `per_secnod` silently meaning
 * "monthly" is how DynamoDB capacity would come to look infinitely spacious.
 */
function withBasis(name: string, raw: Record<string, RawLimit>): Record<string, Limit> {
  const out: Record<string, Limit> = {}
  for (const [key, limit] of Object.entries(raw ?? {})) {
    const basis = limit.basis ?? 'monthly'
    if (!LIMIT_BASES.includes(basis as LimitBasis)) {
      throw new Error(
        `budget.yaml: ${name}.${key} has basis '${basis}'. Known: ${LIMIT_BASES.join(', ')}`,
      )
    }
    out[key] = { ...limit, basis: basis as LimitBasis }
  }
  return out
}

let cached: Budget | undefined

/** Load and validate the budget. Cached: synth reads it once per process. */
export function loadBudget(path: string = BUDGET_PATH): Budget {
  if (cached !== undefined && path === BUDGET_PATH) return cached

  const raw = parse(readFileSync(path, 'utf8')) as RawBudget

  // Validate rather than trust. A typo here would silently provision the wrong
  // capacity, and the point of this file is that it cannot.
  for (const field of ['version', 'gate_pct', 'trip_pct'] as const) {
    if (typeof raw[field] !== 'number') {
      throw new Error(`budget.yaml: '${field}' must be a number`)
    }
  }
  if (raw.limits === undefined || Object.keys(raw.limits).length === 0) {
    throw new Error('budget.yaml: no limits defined')
  }

  for (const [name, limit] of Object.entries(raw.limits)) {
    const allocated = Object.values(limit.split).reduce((sum, n) => sum + n, 0)
    if (allocated > limit.total) {
      throw new Error(
        `budget.yaml: '${name}' allocates ${allocated} of a ${limit.total} allowance — ` +
          'the shares exceed what exists',
      )
    }
  }

  const budget: Budget = {
    version: raw.version,
    accountType: raw.account_type,
    region: raw.region,
    gatePct: raw.gate_pct,
    providerGatePct: raw.provider_gate_pct,
    tripPct: raw.trip_pct,
    limits: withBasis('limits', raw.limits),
    providerLimits: withBasis('provider_limits', raw.provider_limits),
    cloudfront: raw.cloudfront,
    neverUse: raw.never_use ?? [],
  }
  if (path === BUDGET_PATH) cached = budget
  return budget
}

/**
 * One environment's share of an allowance.
 *
 * Throws on an unknown limit rather than defaulting: a stack asking for a budget that
 * does not exist is a mistake, and quietly returning 0 would turn it into a capacity
 * bug much further downstream.
 */
export function shareFor(limitName: string, env: EnvName, budget = loadBudget()): number {
  const limit = budget.limits[limitName] ?? budget.providerLimits[limitName]
  if (limit === undefined) {
    const known = [...Object.keys(budget.limits), ...Object.keys(budget.providerLimits)]
    throw new Error(`budget.yaml has no limit '${limitName}'. Known: ${known.join(', ')}`)
  }
  const share = limit.split[env]
  if (share === undefined) {
    throw new Error(`budget.yaml: limit '${limitName}' has no share for '${env}'`)
  }
  return share
}
