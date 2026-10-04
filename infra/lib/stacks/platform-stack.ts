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
import { Alarm, ComparisonOperator } from 'aws-cdk-lib/aws-cloudwatch'
import { AttributeType, Billing, Operation, TableV2 } from 'aws-cdk-lib/aws-dynamodb'
import { Capacity } from 'aws-cdk-lib/aws-dynamodb'
import { ParameterTier, StringParameter } from 'aws-cdk-lib/aws-ssm'
import type { Construct } from 'constructs'
import type { EnvName } from '../config/budget.js'
import { type EnvConfig, envConfig } from '../config/environments.js'
import type { Profile } from '../config/profile.js'
import { Delivery } from '../constructs/delivery.js'
import { Identity } from '../constructs/identity.js'
import { ProviderCommands } from '../constructs/messaging.js'
import { ProfileAwareFactory } from '../factory/profile-aware-factory.js'

export interface PlatformStackProps extends StackProps {
  readonly profile: Profile
  readonly envName: EnvName
}

export class PlatformStack extends Stack {
  readonly factory: ProfileAwareFactory
  readonly config: EnvConfig
  /** Every alarm this environment could afford, in priority order. */
  readonly alarms: readonly Alarm[]

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

    // ---------------------------------------------------------------- M0A-06
    //
    // Commands addressed to one provider adapter, filtered on message attributes.
    const providerCommands = new ProviderCommands(this, 'ProviderCommands', { env: envName })

    const identity = new Identity(this, 'Identity', {
      env: envName,
      removalPolicy: this.config.removalPolicy,
    })

    const delivery = new Delivery(this, 'Delivery', {
      env: envName,
      logRetention: this.config.logRetention,
      removalPolicy: this.config.removalPolicy,
    })

    // Every value a service needs to find the others. SSM standard parameters are free;
    // Secrets Manager is $0.40 per secret per month and is on the never-use list, so
    // actual secrets go to SecureString parameters written by CI, never by synth.
    //
    // The three prefixes are a contract: `config` is wiring, `flags` is behaviour that
    // may change without a deploy, `secrets` is what CI puts there. Nothing here writes
    // under `secrets` — a secret in a synthesized template is a secret in a public
    // repository's CI logs.
    const params: Record<string, string> = {
      'config/table-name': table.tableName,
      'config/profile': profile,
      'config/domain-topic-arn': domain.topic?.topicArn ?? domain.bus?.eventBusArn ?? 'none',
      'config/provider-commands-topic-arn': providerCommands.topic.topicArn,
      'config/dead-letter-queue-url': domain.deadLetterQueue.queueUrl,
      'config/user-pool-id': identity.userPool.userPoolId,
      'config/user-pool-client-id': identity.appClient.userPoolClientId,
      'config/distribution-domain': delivery.distribution.distributionDomainName,
      'flags/kill-switch-engaged': 'false',
      'flags/llm-residual-pass': 'false',
    }
    for (const [name, value] of Object.entries(params)) {
      new StringParameter(this, `Param${name.replace(/[^a-zA-Z0-9]/g, '')}`, {
        parameterName: `/setlist/${envName}/${name}`,
        stringValue: value,
        // Standard tier only. Advanced parameters are $0.05 each per month.
        tier: ParameterTier.STANDARD,
      })
    }

    // Alarms are capped account-wide at 10 free, split prod 5 / stage 2 / dev 0. The
    // budget is enforced by construction rather than by remembering: the list below is
    // in priority order and `slice` takes only what this environment can afford, so a
    // new alarm added at the bottom is silently unaffordable in dev rather than a
    // surprise $0.10 line item. SZC-ALARM-BUDGET catches it from the template side too.
    this.alarms = [
      () =>
        domain.deadLetterQueue
          .metricApproximateNumberOfMessagesVisible()
          .createAlarm(this, 'DlqNotEmpty', {
            alarmName: `setlist-${envName}-dlq-not-empty`,
            threshold: 1,
            evaluationPeriods: 1,
            comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            alarmDescription: 'An async invoke failed every retry and landed in the DLQ.',
          }),
      () =>
        delivery.origin.metricErrors().createAlarm(this, 'BffErrors', {
          alarmName: `setlist-${envName}-bff-errors`,
          threshold: 5,
          evaluationPeriods: 1,
          comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
          alarmDescription: 'The BFF origin is failing.',
        }),
      () =>
        // Built directly rather than through `metric.createAlarm`: the per-operation
        // throttle metric is a math expression (`IMetric`), which has no `createAlarm`.
        new Alarm(this, 'TableThrottled', {
          alarmName: `setlist-${envName}-table-throttled`,
          metric: table.metricThrottledRequestsForOperations({
            operations: [Operation.PUT_ITEM, Operation.QUERY],
          }),
          threshold: 1,
          evaluationPeriods: 1,
          comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          alarmDescription: 'Provisioned capacity is short; the autoscaler has not caught up.',
        }),
    ]
      .slice(0, this.config.maxAlarms)
      .map(make => make())

    new CfnOutput(this, 'EventTransport', {
      value: domain.kind,
      description: 'Resolved domain event transport for this profile.',
    })
    new CfnOutput(this, 'SyncTransport', {
      value: this.factory.choices.sync,
      description: 'Resolved synchronous API transport for this profile.',
    })
    new CfnOutput(this, 'TableName', { value: table.tableName })
    new CfnOutput(this, 'DistributionDomain', {
      value: delivery.distribution.distributionDomainName,
    })
  }
}
