/**
 * The two functions that exist to stop the account costing money.
 *
 * ## The kill switch's permissions are the interesting part
 *
 * It needs to throttle *any* function in the account, disable *any* event source mapping
 * and schedule, and disable distributions — which is a lot of power for something that
 * runs unattended. The narrowing that is actually available is on the actions rather than
 * the resources: `PutFunctionConcurrency` can only ever reduce availability, never create
 * or invoke anything, and the same is true of the rest of this list. There is no action
 * here that can spend money, which is the property worth having for a function whose
 * whole job runs during an incident.
 *
 * It does not get `lambda:InvokeFunction`, `cloudfront:CreateDistribution` or anything
 * that writes outside the single table.
 *
 * ## Bundled with esbuild, never a container image
 *
 * `NodejsFunction` bundles locally when esbuild is resolvable, which is why it is a
 * devDependency of this package. The fallback is Docker bundling, and `make preflight`
 * has to run without Docker (AUTOPILOT §2.6) — so a missing esbuild would turn a fast
 * offline synth into one that cannot run at all on the machine that gates it.
 */

import { Duration, type RemovalPolicy } from 'aws-cdk-lib'
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam'
import { Runtime } from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import { LogGroup, type RetentionDays } from 'aws-cdk-lib/aws-logs'
import { Rule, Schedule } from 'aws-cdk-lib/aws-events'
import { LambdaFunction as LambdaTarget } from 'aws-cdk-lib/aws-events-targets'
import type { Table } from 'aws-cdk-lib/aws-dynamodb'
import { Construct } from 'constructs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { EnvName } from '../config/budget.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')

export interface GuardrailsProps {
  readonly env: EnvName
  readonly logRetention: RetentionDays
  readonly removalPolicy: RemovalPolicy
  // The concrete `Table`, not `ITable`, and not by preference: CDK declares
  // `ITable.tableStreamArn` as `string` while `Table` has `string | undefined`, which
  // `exactOptionalPropertyTypes` rejects outright. Only `tableName` and
  // `grantWriteData` are used here, so if that typing is ever fixed this can widen.
  readonly table: Table
  readonly tripPct: number
  /** Limit name -> this environment's allowance, resolved from budget.yaml at synth. */
  readonly shares: Readonly<Record<string, number>>
  /**
   * The ACCOUNT-wide free alarm allowance, not this environment's share (ADR-013).
   *
   * `DescribeAlarms` sees every alarm in the account regardless of which stack made it,
   * which is the whole point — the alarms being hunted are the ones no stack made. So
   * the number it is compared against has to be the account ceiling too.
   */
  readonly alarmAllowance: number
}

export class Guardrails extends Construct {
  readonly killSwitch: NodejsFunction
  readonly usageSentinel: NodejsFunction

  constructor(scope: Construct, id: string, props: GuardrailsProps) {
    super(scope, id)

    this.killSwitch = new NodejsFunction(this, 'KillSwitch', {
      functionName: `setlist-${props.env}-kill-switch`,
      runtime: Runtime.NODEJS_22_X,
      entry: join(repoRoot, 'services', 'kill-switch', 'src', 'handler.ts'),
      handler: 'handler',
      // Generous for a Lambda that runs once per incident: it pages through every
      // function in the account and fetches tags for each. Timing out halfway is the one
      // failure mode that leaves the system half-stopped.
      timeout: Duration.minutes(5),
      memorySize: 512,
      environment: { TABLE_NAME: props.table.tableName },
      logGroup: new LogGroup(this, 'KillSwitchLogs', {
        logGroupName: `/aws/lambda/setlist-${props.env}-kill-switch`,
        retention: props.logRetention,
        removalPolicy: props.removalPolicy,
      }),
      bundling: {
        // The SDK is on the runtime already; bundling it would add megabytes to a
        // function that has to cold-start fast during an incident.
        externalModules: ['@aws-sdk/*'],
      },
      description: 'Throttles every setlist function to zero when the budget alarm trips.',
    })

    // Every action here reduces availability. None of them can create a resource, invoke
    // anything, or move data — so the blast radius of this role being misused is an
    // outage, not a bill or a leak.
    this.killSwitch.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'lambda:ListFunctions',
          'lambda:ListTags',
          'lambda:PutFunctionConcurrency',
          'lambda:ListEventSourceMappings',
          'lambda:UpdateEventSourceMapping',
          'scheduler:ListSchedules',
          'scheduler:GetSchedule',
          'scheduler:UpdateSchedule',
          'cloudfront:ListDistributions',
          'cloudfront:GetDistributionConfig',
          'cloudfront:UpdateDistribution',
        ],
        resources: ['*'],
      }),
    )
    props.table.grantWriteData(this.killSwitch)

    this.usageSentinel = new NodejsFunction(this, 'UsageSentinel', {
      functionName: `setlist-${props.env}-usage-sentinel`,
      runtime: Runtime.NODEJS_22_X,
      entry: join(repoRoot, 'services', 'usage-sentinel', 'src', 'handler.ts'),
      handler: 'handler',
      timeout: Duration.seconds(60),
      memorySize: 256,
      environment: {
        ENV_NAME: props.env,
        TRIP_PCT: String(props.tripPct),
        // Resolved from budget.yaml at synth time. The function needs four integers, not
        // a YAML parser and a bundled copy of the budget.
        SHARES: JSON.stringify(props.shares),
        ALARM_ALLOWANCE: String(props.alarmAllowance),
      },
      logGroup: new LogGroup(this, 'UsageSentinelLogs', {
        logGroupName: `/aws/lambda/setlist-${props.env}-usage-sentinel`,
        retention: props.logRetention,
        removalPolicy: props.removalPolicy,
      }),
      bundling: { externalModules: ['@aws-sdk/*'] },
      description: 'Reads each free-tier share from free vended metrics and reports a trip.',
    })

    // GetMetricStatistics and DescribeAlarms only. GetMetricData is billed per call and
    // is banned; granting it here would make the ban a convention rather than a control.
    //
    // DescribeAlarms is a Describe call and is free (ADR-013). It is granted on `*` by
    // necessity rather than laziness: the alarms worth finding are the ones no stack of
    // ours created, so a resource-scoped grant would see exactly the alarms that were
    // never the problem.
    this.usageSentinel.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'cloudwatch:GetMetricStatistics',
          'cloudwatch:ListMetrics',
          'cloudwatch:DescribeAlarms',
        ],
        resources: ['*'],
      }),
    )

    // EventBridge Scheduler would be the modern choice; a rule on the default bus is
    // used because custom buses are banned (SZC-EVENTBUS) and the default bus is free.
    new Rule(this, 'SentinelSchedule', {
      ruleName: `setlist-${props.env}-usage-sentinel`,
      description: 'Hourly free-tier share check.',
      schedule: Schedule.rate(Duration.hours(1)),
      targets: [new LambdaTarget(this.usageSentinel)],
    })
  }
}
