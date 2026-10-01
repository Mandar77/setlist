/**
 * Platform stack — the shared substrate every service builds on.
 *
 * Deliberately thin at M0A-02. This task owns the *mechanism*: profile resolution, the
 * factory, and config read from `budget.yaml`. M0A-06 fills in the table, the user
 * pool, the distribution and the kill switch.
 *
 * It is not a placeholder, though: it synthesizes real resources under both profiles,
 * which is what makes the never-use assertions and the six-way synth matrix mean
 * something. A stack with nothing in it would pass every check for the wrong reason.
 */

import { CfnOutput, Stack, type StackProps, Tags } from 'aws-cdk-lib'
import { AttributeType, Billing, TableV2 } from 'aws-cdk-lib/aws-dynamodb'
import { Capacity } from 'aws-cdk-lib/aws-dynamodb'
import { StringParameter } from 'aws-cdk-lib/aws-ssm'
import type { Construct } from 'constructs'
import type { EnvName } from '../config/budget.js'
import { type EnvConfig, envConfig } from '../config/environments.js'
import type { Profile } from '../config/profile.js'
import { ProfileAwareFactory } from '../factory/profile-aware-factory.js'

export interface PlatformStackProps extends StackProps {
  readonly profile: Profile
  readonly envName: EnvName
}

export class PlatformStack extends Stack {
  readonly factory: ProfileAwareFactory
  readonly config: EnvConfig

  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props)

    const { profile, envName } = props
    this.config = envConfig(envName)
    this.factory = new ProfileAwareFactory({ profile, env: envName })

    // Tags are how the kill switch finds everything it must throttle to zero.
    Tags.of(this).add('app', 'setlist')
    Tags.of(this).add('env', envName)
    Tags.of(this).add('profile', profile)

    // The domain event bus — SNS under zero, EventBridge under enterprise.
    const domain = this.factory.domainBus(this, 'Domain')

    // Single table, PROVISIONED. On-demand is billed per request and is on the
    // never-use list; the capacity here is this environment's share of an allowance
    // that is account-wide across every table AND index (PED D6).
    const table = new TableV2(this, 'Table', {
      tableName: `setlist-${envName}`,
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      // Autoscaled with a hard ceiling, not fixed. Two reasons, and the second is the
      // one that matters:
      //
      //   * TableV2 rejects FIXED write capacity outright — only read may be fixed.
      //   * The 25 WCU / 25 RCU allowance is consumed by what is *provisioned*, so a
      //     table pinned at its ceiling burns that share around the clock. Scaling to
      //     1 when idle gives the allowance back, while maxCapacity keeps the worst
      //     case at exactly the share this environment is budgeted (PED §11).
      //
      // maxCapacity is therefore the number the estimator and the "total ≤ 17" check
      // reason about: it is the most this environment can ever hold.
      billing: Billing.provisioned({
        readCapacity: Capacity.autoscaled({
          minCapacity: 1,
          maxCapacity: this.config.dynamoCapacity.read,
        }),
        writeCapacity: Capacity.autoscaled({
          minCapacity: 1,
          maxCapacity: this.config.dynamoCapacity.write,
        }),
      }),
      timeToLiveAttribute: 'ttl',
      removalPolicy: this.config.removalPolicy,
      // Point-in-time recovery is billed per GB of backup and is on the never-use
      // list. Stated explicitly rather than left to the default, so the intent is
      // visible in the diff when someone is tempted to turn it on.
      pointInTimeRecovery: false,
    })

    // Config and flags live in SSM standard parameters. Secrets Manager is banned:
    // $0.40 per secret per month is not $0.
    new StringParameter(this, 'TableNameParam', {
      parameterName: `/setlist/${envName}/config/table-name`,
      stringValue: table.tableName,
      description: 'Single-table name, read by every service.',
    })

    new StringParameter(this, 'ProfileParam', {
      parameterName: `/setlist/${envName}/config/profile`,
      stringValue: profile,
      description: 'Which profile this environment was synthesized under.',
    })

    new CfnOutput(this, 'EventTransport', {
      value: domain.kind,
      description: 'Resolved domain event transport for this profile.',
    })
    new CfnOutput(this, 'SyncTransport', {
      value: this.factory.choices.sync,
      description: 'Resolved synchronous API transport for this profile.',
    })
    new CfnOutput(this, 'TableName', { value: table.tableName })
  }
}
