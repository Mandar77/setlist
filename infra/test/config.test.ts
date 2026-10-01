/**
 * Profile resolution, environment config, and the budget the config is read from.
 *
 * The theme: refuse rather than guess. A wrong profile or a missing quota share should
 * stop synthesis with a sentence, not pick a plausible default and provision something
 * nobody chose.
 */

import { App } from 'aws-cdk-lib'
import { describe, expect, it } from 'vitest'
import { ENV_NAMES, loadBudget, shareFor } from '../lib/config/budget.js'
import { envConfig, totalProvisionedCapacity } from '../lib/config/environments.js'
import {
  DEFAULT_PROFILE,
  resolveAccount,
  resolveEnv,
  resolveProfile,
  stackName,
} from '../lib/config/profile.js'
import { transportChoices } from '../lib/factory/profile-aware-factory.js'

const appWith = (context: Record<string, unknown>): App => new App({ context })

describe('profile resolution', () => {
  it('defaults to zero when nothing is asked for', () => {
    // A default that costs money is a default that will eventually be taken.
    expect(resolveProfile(appWith({}))).toBe('zero')
    expect(DEFAULT_PROFILE).toBe('zero')
  })

  it('accepts enterprise only when named', () => {
    expect(resolveProfile(appWith({ profile: 'enterprise' }))).toBe('enterprise')
  })

  it('refuses an unknown profile rather than falling back', () => {
    expect(() => resolveProfile(appWith({ profile: 'cheap' }))).toThrow(/unknown profile/)
  })

  it('requires an environment', () => {
    // There is no safe default deployment target; guessing one risks touching prod.
    expect(() => resolveEnv(appWith({}))).toThrow(/no environment given/)
  })

  it('refuses an unknown environment', () => {
    expect(() => resolveEnv(appWith({ env: 'production' }))).toThrow(/unknown environment/)
  })

  it('reads the account from the session, not a lookup', () => {
    const before = process.env['CDK_DEFAULT_ACCOUNT']
    try {
      delete process.env['CDK_DEFAULT_ACCOUNT']
      delete process.env['AWS_ACCOUNT_ID']
      // Undefined is correct, not an error: synth must work offline on a machine that
      // holds no credentials (ADR-005).
      expect(resolveAccount()).toBeUndefined()

      process.env['CDK_DEFAULT_ACCOUNT'] = '000000000000'
      expect(resolveAccount()).toBe('000000000000')
    } finally {
      if (before === undefined) delete process.env['CDK_DEFAULT_ACCOUNT']
      else process.env['CDK_DEFAULT_ACCOUNT'] = before
    }
  })

  it('names stacks by environment so they stay isolated', () => {
    expect(stackName('dev', 'platform')).toBe('setlist-dev-platform')
  })
})

describe('transport choices', () => {
  it('routes zero around everything that is not always-free', () => {
    expect(transportChoices('zero')).toEqual({
      events: 'sns',
      sync: 'function-url',
      orchestrator: 'lambda-saga',
      fanOut: 'sns-direct',
    })
  })

  it('gives enterprise the PRD design', () => {
    expect(transportChoices('enterprise')).toEqual({
      events: 'eventbridge',
      sync: 'api-gateway',
      orchestrator: 'step-functions',
      fanOut: 'sqs-event-source',
    })
  })

  it('differs on every axis, so no choice is accidentally shared', () => {
    const zero = transportChoices('zero')
    const enterprise = transportChoices('enterprise')
    for (const key of Object.keys(zero) as Array<keyof typeof zero>) {
      expect(zero[key], `${key} is the same in both profiles`).not.toBe(enterprise[key])
    }
  })
})

describe('budget.yaml is the single source of capacity', () => {
  it('loads and validates', () => {
    const budget = loadBudget()
    expect(budget.gatePct).toBe(70)
    expect(budget.tripPct).toBe(85)
    expect(budget.region).toBe('us-east-1')
  })

  it('never allocates more than an allowance holds', () => {
    // loadBudget() throws on over-allocation; this asserts the invariant directly too,
    // so the message names the limit rather than just failing to parse.
    const budget = loadBudget()
    for (const [name, limit] of Object.entries(budget.limits)) {
      const allocated = Object.values(limit.split).reduce((sum, n) => sum + n, 0)
      expect(allocated, `${name} over-allocates`).toBeLessThanOrEqual(limit.total)
    }
  })

  it('keeps provisioned DynamoDB at or under the 17 the PED budgets', () => {
    // The 25/25 allowance is account-wide across every table AND index, so this cannot
    // be reasoned about one stack at a time.
    const { read, write } = totalProvisionedCapacity()
    expect(read).toBeLessThanOrEqual(17)
    expect(write).toBeLessThanOrEqual(17)
  })

  it('refuses an unknown limit instead of returning zero', () => {
    expect(() => shareFor('dynamodb_iops', 'dev')).toThrow(/has no limit/)
  })

  it('keeps YouTube as the binding constraint it is', () => {
    // 800 units per 15-song playlist; prod's share is ~8 playlists/day.
    const prod = shareFor('youtube_units_per_day', 'prod')
    expect(prod).toBe(7000)
    expect(Math.floor(prod / 800)).toBe(8)
  })
})

describe('environment config', () => {
  it('gives every environment an explicit log retention', () => {
    for (const env of ENV_NAMES) {
      expect(envConfig(env).logRetention).toBeDefined()
    }
  })

  it('retains prod and discards the disposable environments', () => {
    expect(envConfig('prod').removalPolicy).toBe('retain')
    expect(envConfig('dev').removalPolicy).toBe('destroy')
    expect(envConfig('stage').removalPolicy).toBe('destroy')
  })

  it('canaries only in prod, where the alarm budget is', () => {
    expect(envConfig('prod').canaryDeployments).toBe(true)
    expect(envConfig('dev').canaryDeployments).toBe(false)
  })

  it('takes its capacity from budget.yaml rather than a second copy', () => {
    for (const env of ENV_NAMES) {
      const config = envConfig(env)
      expect(config.dynamoCapacity.read).toBe(shareFor('dynamodb_rcu', env))
      expect(config.dynamoCapacity.write).toBe(shareFor('dynamodb_wcu', env))
    }
  })
})
