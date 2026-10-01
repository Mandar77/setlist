/**
 * Paired fixtures: for every SZC rule, a stack that violates it and one that does not.
 *
 * Both halves are load-bearing. The violating stack proves the rule fires; the
 * compliant one proves it is not simply failing everything, which is the way a broken
 * rule disguises itself as a working one. A pack that rejects every input looks
 * identical to a strict pack right up until it blocks something legitimate.
 *
 * Fixtures are keyed by rule id, and `pack.test.ts` asserts the key set matches
 * SZC_RULE_IDS exactly — so a new rule cannot land without both halves.
 */

import { Duration } from 'aws-cdk-lib'
import type { Stack } from 'aws-cdk-lib'
import { CfnEventBus } from 'aws-cdk-lib/aws-events'
import { CfnHostedZone } from 'aws-cdk-lib/aws-route53'
import { CfnRepository } from 'aws-cdk-lib/aws-ecr'
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2'
import { CfnJob } from 'aws-cdk-lib/aws-glue'
import { CfnCanary } from 'aws-cdk-lib/aws-synthetics'
import { CfnRestApi } from 'aws-cdk-lib/aws-apigateway'
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb'
import { Key } from 'aws-cdk-lib/aws-kms'
import { Secret } from 'aws-cdk-lib/aws-secretsmanager'
import { Bucket } from 'aws-cdk-lib/aws-s3'
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs'
import {
  CfnFunction,
  type CfnVersion,
  Code,
  Function as LambdaFunction,
  Runtime,
} from 'aws-cdk-lib/aws-lambda'
import { CfnStateMachine } from 'aws-cdk-lib/aws-stepfunctions'
import { Queue } from 'aws-cdk-lib/aws-sqs'
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources'
import { CfnInstance, CfnNatGateway } from 'aws-cdk-lib/aws-ec2'
import { CfnAlarm } from 'aws-cdk-lib/aws-cloudwatch'
import { type IPrincipal, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam'
import type { Construct } from 'constructs'
import { loadBudget } from '../../lib/config/budget.js'

/**
 * The account-wide alarm allowance, which is what the pack enforces when a stack
 * carries no `env` context — as these fixture stacks do.
 */
const ALARM_CEILING = loadBudget().limits['cloudwatch_alarms']?.total ?? 0

/** Builds resources into a stack. */
export type FixtureBuilder = (scope: Stack) => void

export interface FixturePair {
  /** Must trigger the rule. */
  readonly violating: FixtureBuilder
  /** Must NOT trigger it — the control that proves the rule discriminates. */
  readonly compliant: FixtureBuilder
}

/**
 * A role ARN for an L1 that demands one, built from the stack's own account token.
 *
 * Not a hard-coded ARN with the twelve-digit documentation account in it. That value
 * leaks nothing, but ADR-005 bans account ids and ARNs from this public repo outright,
 * and a scanner that tried to tell a placeholder from a real id would be making exactly
 * the judgement call you do not want it making — `tools/check_no_secrets.py` flagged
 * even the comment that used to explain this, which is the correct amount of
 * discrimination for a secret scanner to have. This renders as `Ref: AWS::AccountId`,
 * which is the idiomatic form anyway.
 */
function fixtureRoleArn(scope: Stack): string {
  return scope.formatArn({ service: 'iam', region: '', resource: 'role', resourceName: 'fixture' })
}

/** A plain inline Lambda, used wherever a fixture needs a function to modify. */
function lambda(scope: Construct, id: string): LambdaFunction {
  return new LambdaFunction(scope, id, {
    runtime: Runtime.NODEJS_22_X,
    handler: 'index.handler',
    code: Code.fromInline('export const handler = async () => {}'),
  })
}

/** `count` identical alarms, for the alarm-budget fixtures. */
function alarms(scope: Construct, count: number): void {
  for (let i = 0; i < count; i += 1) {
    new CfnAlarm(scope, `Alarm${i}`, {
      comparisonOperator: 'GreaterThanThreshold',
      evaluationPeriods: 1,
      namespace: 'AWS/Lambda',
      metricName: 'Errors',
      period: 60,
      statistic: 'Sum',
      threshold: 1,
    })
  }
}

/**
 * A service principal, cast once.
 *
 * `ServicePrincipal` is not assignable to `IPrincipal` under
 * `exactOptionalPropertyTypes`: the interface declares `principalAccount?: string` and
 * the class widens it to `string | undefined`. That is a mismatch inside CDK's own
 * types, so the cast is the fix — just not one worth repeating at every call site.
 */
function servicePrincipal(service: string): IPrincipal {
  return new ServicePrincipal(service) as IPrincipal
}

/** A provisioned table, the compliant shape for every DynamoDB fixture. */
function provisionedTable(scope: Construct, id: string): Table {
  return new Table(scope, id, {
    partitionKey: { name: 'pk', type: AttributeType.STRING },
    billingMode: BillingMode.PROVISIONED,
    readCapacity: 1,
    writeCapacity: 1,
  })
}

export const FIXTURES: Readonly<Record<string, FixturePair>> = {
  'SZC-NAT': {
    violating: s => {
      new CfnNatGateway(s, 'Nat', { subnetId: 'subnet-123', allocationId: 'eipalloc-123' })
    },
    compliant: s => {
      lambda(s, 'Fn')
    },
  },

  'SZC-COMPUTE': {
    violating: s => {
      new CfnInstance(s, 'Box', { imageId: 'ami-123' })
    },
    compliant: s => {
      lambda(s, 'Fn')
    },
  },

  'SZC-LAMBDA-VPC': {
    violating: s => {
      const fn = lambda(s, 'Fn')
      // Set at the L1 level: attaching a real Vpc would also create a NAT gateway and
      // trip a different rule, which would make this fixture prove the wrong thing.
      //
      // It is also the escape hatch itself under test. `fn.vpcConfig` stays undefined
      // after this, so a rule reading the typed accessor sees nothing while the
      // template gets a VpcConfig — which is how SZC-LAMBDA-VPC first passed a
      // violating fixture.
      const l1 = fn.node.defaultChild as CfnFunction
      l1.addPropertyOverride('VpcConfig', {
        SubnetIds: ['subnet-123'],
        SecurityGroupIds: ['sg-123'],
      })
    },
    compliant: s => {
      lambda(s, 'Fn')
    },
  },

  'SZC-LAMBDA-PROVISIONED': {
    violating: s => {
      const fn = lambda(s, 'Fn')
      // Another escape hatch, for the same reason as SZC-LAMBDA-VPC above: the typed
      // `provisionedConcurrencyConfig` stays undefined while the template gets the
      // property.
      const l1 = fn.currentVersion.node.defaultChild as CfnVersion
      l1.addPropertyOverride('ProvisionedConcurrencyConfig', {
        ProvisionedConcurrentExecutions: 1,
      })
    },
    compliant: s => {
      const fn = lambda(s, 'Fn')
      // A version with no provisioned concurrency is fine, and proves the rule is
      // looking at the property rather than at the resource type. The metadata is
      // only there to make reading `currentVersion` a statement rather than a bare
      // expression; it has no effect on the template.
      fn.currentVersion.node.addMetadata('fixture', 'version without provisioned concurrency')
    },
  },

  'SZC-LAMBDA-IMAGE': {
    violating: s => {
      // L1, with ImageUri set directly. `Code.fromAssetImage` would build a container
      // at synth time, and `make verify` must run without Docker — a fixture that
      // needs a daemon is a fixture that gets skipped.
      new CfnFunction(s, 'ImageFn', {
        role: fixtureRoleArn(s),
        packageType: 'Image',
        code: { imageUri: `${s.account}.dkr.ecr.${s.region}.amazonaws.com/fixture:latest` },
      })
    },
    compliant: s => {
      lambda(s, 'ZipFn')
    },
  },

  'SZC-ECR': {
    violating: s => {
      new CfnRepository(s, 'Repo', { repositoryName: 'setlist-fixture' })
    },
    compliant: s => {
      lambda(s, 'Fn')
    },
  },

  'SZC-KMS-CMK': {
    violating: s => {
      new Key(s, 'Cmk')
    },
    compliant: s => {
      // AWS-managed encryption is free; a customer-managed key is $1/month.
      new Queue(s, 'Q', { enforceSSL: true })
    },
  },

  'SZC-SECRETS-MANAGER': {
    violating: s => {
      new Secret(s, 'Secret')
    },
    compliant: s => {
      lambda(s, 'Fn')
    },
  },

  'SZC-WAF': {
    violating: s => {
      new CfnWebACL(s, 'Acl', {
        scope: 'CLOUDFRONT',
        defaultAction: { allow: {} },
        visibilityConfig: {
          cloudWatchMetricsEnabled: false,
          metricName: 'fixture',
          sampledRequestsEnabled: false,
        },
      })
    },
    compliant: s => {
      lambda(s, 'Fn')
    },
  },

  'SZC-ROUTE53': {
    violating: s => {
      new CfnHostedZone(s, 'Zone', { name: 'example.com' })
    },
    compliant: s => {
      lambda(s, 'Fn')
    },
  },

  'SZC-APIGW': {
    violating: s => {
      new CfnRestApi(s, 'Api', { name: 'fixture' })
    },
    compliant: s => {
      // A Function URL is the zero-profile replacement and costs nothing.
      lambda(s, 'Fn').addFunctionUrl()
    },
  },

  'SZC-EVENTBUS': {
    violating: s => {
      new CfnEventBus(s, 'Bus', { name: 'fixture-bus' })
    },
    compliant: s => {
      lambda(s, 'Fn')
    },
  },

  'SZC-SFN-EXPRESS': {
    violating: s => {
      new CfnStateMachine(s, 'Sm', {
        roleArn: fixtureRoleArn(s),
        stateMachineType: 'EXPRESS',
        definitionString: '{"StartAt":"X","States":{"X":{"Type":"Succeed"}}}',
      })
    },
    compliant: s => {
      // Standard has 4,000 free transitions; Express has none.
      new CfnStateMachine(s, 'Sm', {
        roleArn: fixtureRoleArn(s),
        stateMachineType: 'STANDARD',
        definitionString: '{"StartAt":"X","States":{"X":{"Type":"Succeed"}}}',
      })
    },
  },

  'SZC-SQS-ESM': {
    violating: s => {
      const queue = new Queue(s, 'Q', { enforceSSL: true })
      lambda(s, 'Fn').addEventSource(new SqsEventSource(queue))
    },
    compliant: s => {
      // A queue used only as a dead-letter target has no poller and costs nothing.
      new Queue(s, 'Dlq', { enforceSSL: true, retentionPeriod: Duration.days(14) })
      lambda(s, 'Fn')
    },
  },

  'SZC-DDB-ONDEMAND': {
    violating: s => {
      new Table(s, 'T', {
        partitionKey: { name: 'pk', type: AttributeType.STRING },
        billingMode: BillingMode.PAY_PER_REQUEST,
      })
    },
    compliant: s => {
      provisionedTable(s, 'T')
    },
  },

  'SZC-DDB-PITR': {
    violating: s => {
      new Table(s, 'T', {
        partitionKey: { name: 'pk', type: AttributeType.STRING },
        billingMode: BillingMode.PROVISIONED,
        readCapacity: 1,
        writeCapacity: 1,
        pointInTimeRecovery: true,
      })
    },
    compliant: s => {
      provisionedTable(s, 'T')
    },
  },

  'SZC-GLUE': {
    violating: s => {
      new CfnJob(s, 'Job', {
        role: fixtureRoleArn(s),
        command: { name: 'pythonshell', scriptLocation: 's3://fixture/script.py' },
      })
    },
    compliant: s => {
      lambda(s, 'Fn')
    },
  },

  'SZC-LOG-RETENTION': {
    violating: s => {
      // INFINITE is the real 'never expire' value; logs then accrue storage forever.
      new LogGroup(s, 'Logs', { retention: RetentionDays.INFINITE })
    },
    compliant: s => {
      new LogGroup(s, 'Logs', { retention: RetentionDays.THREE_DAYS })
    },
  },

  'SZC-S3-LIFECYCLE': {
    violating: s => {
      new Bucket(s, 'Bucket')
    },
    compliant: s => {
      new Bucket(s, 'Bucket', {
        lifecycleRules: [{ expiration: Duration.days(1) }],
      })
    },
  },

  'SZC-SYNTHETICS': {
    violating: s => {
      new CfnCanary(s, 'Canary', {
        name: 'fixture',
        artifactS3Location: 's3://fixture/',
        executionRoleArn: fixtureRoleArn(s),
        runtimeVersion: 'syn-nodejs-puppeteer-9.0',
        schedule: { expression: 'rate(1 hour)' },
        code: { handler: 'index.handler', script: 'exports.handler = async () => {}' },
        startCanaryAfterCreation: false,
      })
    },
    compliant: s => {
      lambda(s, 'Fn')
    },
  },

  'SZC-ALARM-BUDGET': {
    violating: s => {
      // One past the account-wide ceiling. The count is read from budget.yaml rather
      // than written here, so changing the allowance cannot leave the fixture testing
      // a number the rule no longer uses.
      alarms(s, ALARM_CEILING + 1)
    },
    compliant: s => {
      // Exactly at the ceiling — the boundary case. A rule comparing with `>` instead
      // of `>=`, or counting from 1, passes the violating fixture and fails here.
      alarms(s, ALARM_CEILING)
      lambda(s, 'Fn')
    },
  },

  'SZC-BANNED-SERVICE-IAM': {
    violating: s => {
      const role = new Role(s, 'Role', { assumedBy: servicePrincipal('lambda.amazonaws.com') })
      role.addToPolicy(new PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: ['*'] }))
    },
    compliant: s => {
      const role = new Role(s, 'Role', { assumedBy: servicePrincipal('lambda.amazonaws.com') })
      role.addToPolicy(new PolicyStatement({ actions: ['sns:Publish'], resources: ['*'] }))
    },
  },
} as const
