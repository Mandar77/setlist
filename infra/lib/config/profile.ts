/**
 * Profile and environment resolution.
 *
 * Two orthogonal axes:
 *
 *   profile — WHICH SERVICES are used. `zero` routes around everything that is not
 *             always-free; `enterprise` is the PRD's original design, available behind
 *             an explicit flag and never by accident.
 *   env     — WHICH DEPLOYMENT it is. dev / stage / prod, each with its own share of
 *             the free-tier allowances.
 *
 * `zero` is the default, and `enterprise` must be asked for by name. A default that
 * costs money is a default that will eventually be taken.
 */

import type { App } from 'aws-cdk-lib'
import { ENV_NAMES, type EnvName } from './budget.js'

export type Profile = 'zero' | 'enterprise'
export const PROFILES: readonly Profile[] = ['zero', 'enterprise'] as const

export const DEFAULT_PROFILE: Profile = 'zero'

/** Single region. Multi-region is not free and is not needed. */
export const REGION = 'us-east-1'

export interface Resolved {
  readonly profile: Profile
  readonly env: EnvName
  /**
   * The AWS account, when one is known.
   *
   * Supplied by the CI session (ADR-005: nothing holds AWS credentials locally), so
   * it is routinely `undefined` during a local `cdk synth`. That is deliberate — the
   * stacks stay environment-agnostic and synthesize offline, which is what lets
   * `make synth` be part of a gate that must not need credentials.
   */
  readonly account: string | undefined
}

function fail(message: string): never {
  throw new Error(message)
}

/** Read `-c profile=...`, defaulting to `zero`. */
export function resolveProfile(app: App): Profile {
  const raw = app.node.tryGetContext('profile') as unknown
  if (raw === undefined || raw === null || raw === '') return DEFAULT_PROFILE
  if (typeof raw !== 'string' || !PROFILES.includes(raw as Profile)) {
    fail(`unknown profile ${String(raw)}. Expected one of: ${PROFILES.join(', ')}`)
  }
  return raw as Profile
}

/** Read `-c env=...`. Required: there is no sensible default deployment target. */
export function resolveEnv(app: App): EnvName {
  const raw = app.node.tryGetContext('env') as unknown
  if (raw === undefined || raw === null || raw === '') {
    fail(`no environment given. Pass -c env=<${ENV_NAMES.join('|')}>`)
  }
  if (typeof raw !== 'string' || !ENV_NAMES.includes(raw as EnvName)) {
    fail(`unknown environment ${String(raw)}. Expected one of: ${ENV_NAMES.join(', ')}`)
  }
  return raw as EnvName
}

/**
 * The account, from the CI session only.
 *
 * Never a context lookup. `Vpc.fromLookup` and friends call AWS during synth, which
 * would make `cdk synth` require credentials — and ADR-005 says this machine has none.
 * An offline synth is also what makes the policy gate runnable before anything exists.
 */
export function resolveAccount(): string | undefined {
  const account = process.env['CDK_DEFAULT_ACCOUNT'] ?? process.env['AWS_ACCOUNT_ID']
  return account === undefined || account === '' ? undefined : account
}

export function resolve(app: App): Resolved {
  return { profile: resolveProfile(app), env: resolveEnv(app), account: resolveAccount() }
}

/** Stack name: `setlist-{env}-{component}`. Prefixing is how environments stay isolated. */
export function stackName(env: EnvName, component: string): string {
  return `setlist-${env}-${component}`
}
