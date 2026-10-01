/**
 * Per-environment configuration.
 *
 * Every capacity number here is read from `infra/free-tier/budget.yaml` rather than
 * written down again. That file is what the CI estimator gates on and what the runtime
 * sentinel trips on, so a second copy in the stacks would be a third opinion nobody
 * reconciles.
 */

import { RemovalPolicy } from 'aws-cdk-lib'
import { RetentionDays } from 'aws-cdk-lib/aws-logs'
import { type Budget, type EnvName, loadBudget, shareFor } from './budget.js'

export interface EnvConfig {
  readonly env: EnvName
  /** Log retention. PED §10.6 — prod 14d, stage 7d, dev 3d. Never "never". */
  readonly logRetention: RetentionDays
  /** dev and stage are disposable; prod is not. */
  readonly removalPolicy: RemovalPolicy
  /** This environment's slice of the shared account-wide DynamoDB allowance. */
  readonly dynamoCapacity: { readonly read: number; readonly write: number }
  /** Alarms are capped at 10 account-wide, so each environment gets a share. */
  readonly maxAlarms: number
  /** YouTube units per day. The binding constraint on the whole product. */
  readonly youtubeUnitsPerDay: number
  /** Only prod gets a canary deployment; everywhere else it is wasted alarm budget. */
  readonly canaryDeployments: boolean
}

const LOG_RETENTION: Record<EnvName, RetentionDays> = {
  prod: RetentionDays.TWO_WEEKS,
  stage: RetentionDays.ONE_WEEK,
  dev: RetentionDays.THREE_DAYS,
}

export function envConfig(env: EnvName, budget: Budget = loadBudget()): EnvConfig {
  return {
    env,
    logRetention: LOG_RETENTION[env],
    removalPolicy: env === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    dynamoCapacity: {
      read: shareFor('dynamodb_rcu', env, budget),
      write: shareFor('dynamodb_wcu', env, budget),
    },
    maxAlarms: shareFor('cloudwatch_alarms', env, budget),
    youtubeUnitsPerDay: shareFor('youtube_units_per_day', env, budget),
    canaryDeployments: env === 'prod',
  }
}

/**
 * Total provisioned DynamoDB capacity across every environment.
 *
 * The 25 WCU / 25 RCU free allowance is account-wide and shared across every table
 * *and index*, so it cannot be reasoned about one stack at a time. PED D6 budgets 17.
 */
export function totalProvisionedCapacity(budget: Budget = loadBudget()): {
  read: number
  write: number
} {
  const sum = (limit: string): number =>
    (['dev', 'stage', 'prod'] as const).reduce((n, env) => n + shareFor(limit, env, budget), 0)
  return { read: sum('dynamodb_rcu'), write: sum('dynamodb_wcu') }
}
