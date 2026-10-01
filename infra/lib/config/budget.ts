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

/** One allowance and how it is divided. `reserve` is unallocated headroom. */
export interface Limit {
  readonly total: number
  readonly unit?: string
  readonly note?: string
  readonly split: Readonly<Record<string, number>>
}

export interface Budget {
  readonly version: number
  readonly accountType: string
  readonly region: string
  /** CI fails above this share of any allowance. */
  readonly gatePct: number
  /** The runtime sentinel throttles above this share. */
  readonly tripPct: number
  readonly limits: Readonly<Record<string, Limit>>
  readonly providerLimits: Readonly<Record<string, Limit>>
  /** Resource descriptions that must never appear in a synthesized template. */
  readonly neverUse: readonly string[]
}

interface RawBudget {
  version: number
  account_type: string
  region: string
  gate_pct: number
  trip_pct: number
  limits: Record<string, Limit>
  provider_limits: Record<string, Limit>
  never_use: string[]
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
    tripPct: raw.trip_pct,
    limits: raw.limits,
    providerLimits: raw.provider_limits ?? {},
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
