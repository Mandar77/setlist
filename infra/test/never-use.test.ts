/**
 * The $0 guarantee, asserted against a synthesized template.
 *
 * This is the backstop for the cdk-nag pack (M0A-03): nag enforces at synth, this
 * proves the enforcement is real by checking the CloudFormation that actually comes
 * out. A rule that is configured but not firing and a rule that is firing look
 * identical from the outside — only the output distinguishes them.
 *
 * Every entry below maps to a line in PED §12's never-use list and to `never_use` in
 * `infra/free-tier/budget.yaml`. The last test asserts that mapping stays complete, so
 * a new banned service cannot be added to the budget and silently go unasserted here.
 */

import { App } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { describe, expect, it } from 'vitest'
import { type EnvName, ENV_NAMES, loadBudget } from '../lib/config/budget.js'
import { envConfig } from '../lib/config/environments.js'
import { PROFILES, type Profile, REGION } from '../lib/config/profile.js'
import { PlatformStack } from '../lib/stacks/platform-stack.js'

/**
 * A synthesized resource's Properties.
 *
 * `findResources` returns an index-signature type, and `noPropertyAccessFromIndexSignature`
 * requires bracket access on those. One helper beats bracket noise at every call site.
 */
function props(resource: Record<string, unknown>): Record<string, any> {
  return (resource['Properties'] ?? {}) as Record<string, any>
}

function synth(profile: Profile, envName: EnvName): Template {
  const app = new App({ context: { profile, env: envName } })
  const stack = new PlatformStack(app, `setlist-${envName}-platform`, {
    profile,
    envName,
    env: { region: REGION },
  })
  return Template.fromStack(stack)
}

/**
 * CloudFormation resource types that must never appear under `profile=zero`, each with
 * the reason it costs money. The reason is in the test because a bare type name does
 * not tell the next person why they cannot have it.
 */
const BANNED_TYPES: ReadonlyArray<readonly [string, string]> = [
  ['AWS::EC2::NatGateway', 'hourly charge, no free tier'],
  ['AWS::EC2::Instance', 'hourly charge'],
  ['AWS::RDS::DBInstance', 'hourly charge'],
  ['AWS::RDS::DBCluster', 'hourly charge'],
  ['AWS::ElasticLoadBalancingV2::LoadBalancer', 'hourly charge'],
  ['AWS::KMS::Key', '$1 per key per month; use an SSM SecureString data key (PED D7)'],
  ['AWS::SecretsManager::Secret', '$0.40 per secret per month; use SSM (PED D10-11)'],
  ['AWS::WAFv2::WebACL', 'billed standalone; prod uses the CloudFront flat-rate plan (D2)'],
  ['AWS::Route53::HostedZone', 'monthly charge; *.cloudfront.net is free'],
  ['AWS::ApiGateway::RestApi', 'credits-only for new accounts; use Function URLs (D1)'],
  ['AWS::ApiGatewayV2::Api', 'credits-only for new accounts; use Function URLs (D1)'],
  ['AWS::Events::EventBus', 'custom bus events have no free tier; use SNS (D3)'],
  ['AWS::Lambda::EventSourceMapping', 'idle pollers burn the SQS allowance (D5)'],
  ['AWS::Glue::Job', 'no $0 option; ETL runs as a Lambda (D8)'],
  ['AWS::Glue::Crawler', 'no $0 option'],
  ['AWS::ECR::Repository', 'storage is billed; Lambdas are zip-packaged'],
  ['AWS::Synthetics::Canary', 'billed per run'],
  ['AWS::CloudFront::Distribution', 'enrolled manually in the flat-rate Free plan (HITL)'],
  [
    'AWS::ApplicationAutoScaling::ScalableTarget',
    'creates CloudWatch alarms at runtime, outside the template, against a 10-alarm allowance (ADR-013)',
  ],
  ['AWS::ApplicationAutoScaling::ScalingPolicy', 'the policy is what creates the alarms (ADR-013)'],
  [
    'AWS::DynamoDB::GlobalTable',
    'global tables replicate and bill per replica; never_use bans them',
  ],
]

describe('profile=zero synthesizes nothing that costs money', () => {
  for (const envName of ENV_NAMES) {
    describe(envName, () => {
      const template = synth('zero', envName)

      for (const [type, why] of BANNED_TYPES) {
        it(`has no ${type} — ${why}`, () => {
          template.resourceCountIs(type, 0)
        })
      }

      it('provisions DynamoDB rather than billing per request', () => {
        // PAY_PER_REQUEST is billed per request and is on the never-use list. The
        // non-empty assertion matters: with no tables at all, a "none are on-demand"
        // loop passes vacuously.
        const tables = template.findResources('AWS::DynamoDB::Table')
        expect(Object.keys(tables).length).toBeGreaterThan(0)
        for (const table of Object.values(tables)) {
          // `ProvisionedThroughput` carries the claim — CloudFormation rejects it on a
          // PAY_PER_REQUEST table. `BillingMode` is absent on a provisioned table
          // because PROVISIONED is the CloudFormation default, so it can only be
          // asserted negatively.
          expect(props(table)['BillingMode']).not.toBe('PAY_PER_REQUEST')
          expect(props(table)['ProvisionedThroughput']).toBeDefined()
        }
      })

      it('provisions exactly this environment’s share, as a fixed number', () => {
        // ADR-013. Fixed, so the number in the template IS the number in the account —
        // there is no ceiling-versus-current distinction left to get wrong.
        //
        // The previous version of this test looped over
        // `AWS::ApplicationAutoScaling::ScalableTarget`, which TableV2 never emitted
        // because a GlobalTable carries autoscaling inline. It passed for two months by
        // iterating an empty set. Hence the length assertion below: a loop over nothing
        // must fail here, not pass.
        const expected = envConfig(envName).dynamoCapacity
        const tables = Object.values(template.findResources('AWS::DynamoDB::Table'))
        expect(tables).toHaveLength(1)
        const throughput = props(tables[0]!)['ProvisionedThroughput']
        expect(throughput.ReadCapacityUnits).toBe(expected.read)
        expect(throughput.WriteCapacityUnits).toBe(expected.write)
      })

      it('keeps point-in-time recovery off', () => {
        const tables = template.findResources('AWS::DynamoDB::Table')
        expect(Object.keys(tables).length).toBeGreaterThan(0)
        for (const table of Object.values(tables)) {
          const pitr = props(table)['PointInTimeRecoverySpecification']?.PointInTimeRecoveryEnabled
          expect(pitr === undefined || pitr === false).toBe(true)
        }
      })

      it('uses no Application Auto Scaling, in either shape', () => {
        // ADR-013. Autoscaling creates CloudWatch alarms at runtime, in the account and
        // not in the template, so it consumes the 10-alarm allowance somewhere neither
        // SZC-ALARM-BUDGET nor this file can see.
        //
        // TWO shapes, because the obvious ban catches only one of them. A v1 `Table`
        // with `autoScaleWriteCapacity()` emits ApplicationAutoScaling resources; a
        // `TableV2` emits none and puts the same behaviour inside the table's own
        // properties. Checking only the resource types is how this went unnoticed
        // before — so the second assertion searches the rendered DynamoDB properties
        // for the inline settings by name.
        template.resourceCountIs('AWS::ApplicationAutoScaling::ScalableTarget', 0)
        template.resourceCountIs('AWS::ApplicationAutoScaling::ScalingPolicy', 0)

        for (const type of ['AWS::DynamoDB::Table', 'AWS::DynamoDB::GlobalTable']) {
          for (const table of Object.values(template.findResources(type))) {
            const rendered = JSON.stringify(props(table))
            expect(rendered).not.toContain('ReadCapacityAutoScalingSettings')
            expect(rendered).not.toContain('WriteCapacityAutoScalingSettings')
          }
        }
      })

      it('puts no Lambda inside a VPC', () => {
        // A VPC Lambda needs an ENI, and egress needs a NAT gateway at $0.045/hour.
        for (const fn of Object.values(template.findResources('AWS::Lambda::Function'))) {
          expect(props(fn)['VpcConfig']).toBeUndefined()
        }
      })

      it('uses no provisioned concurrency', () => {
        // Provisioned concurrency is billed hourly AND removes the function from the
        // always-free Lambda allowance entirely.
        for (const version of Object.values(template.findResources('AWS::Lambda::Version'))) {
          expect(props(version)['ProvisionedConcurrencyConfig']).toBeUndefined()
        }
        for (const alias of Object.values(template.findResources('AWS::Lambda::Alias'))) {
          expect(props(alias)['ProvisionedConcurrencyConfig']).toBeUndefined()
        }
      })

      it('creates no Express state machine', () => {
        for (const sm of Object.values(
          template.findResources('AWS::StepFunctions::StateMachine'),
        )) {
          expect(props(sm)['StateMachineType']).not.toBe('EXPRESS')
        }
      })

      it('gives every log group an explicit retention', () => {
        // A log group with no retention keeps logs forever, and the 5 GB allowance is
        // ingest — storage accrues quietly.
        for (const group of Object.values(template.findResources('AWS::Logs::LogGroup'))) {
          expect(props(group)['RetentionInDays']).toBeDefined()
        }
      })

      it('gives every bucket a lifecycle rule', () => {
        for (const bucket of Object.values(template.findResources('AWS::S3::Bucket'))) {
          expect(props(bucket)['LifecycleConfiguration']).toBeDefined()
        }
      })
    })
  }
})

describe('the banned list stays in step with budget.yaml', () => {
  it('asserts something for every never_use entry', () => {
    const { neverUse } = loadBudget()
    expect(neverUse.length).toBeGreaterThan(10)

    // Each budget.yaml entry is prose, so this maps them to the assertion that covers
    // them. An entry with no mapping fails: adding a banned service to the budget
    // without asserting it here would leave the list looking enforced when it is not.
    const covered = [
      /NAT Gateway/i,
      /Lambda VpcConfig/i,
      /provisioned concurrency/i,
      /KMS::Key|AWS::KMS::Key/i,
      /Secrets Manager/i,
      /WAFv2/i,
      /Route 53/i,
      /API Gateway/i,
      /EventBridge buses/i,
      /Express state machines/i,
      /SQS event source mappings/i,
      /DynamoDB PAY_PER_REQUEST/i,
      /Glue jobs/i,
      /log groups without retention/i,
      /buckets without lifecycle/i,
      /ECR/i,
      /Synthetics/i,
      /alarms/i,
      /FIS, Textract, Bedrock/i,
    ]

    const unmatched = neverUse.filter(entry => !covered.some(pattern => pattern.test(entry)))
    expect(
      unmatched,
      `never_use entries with no assertion in this file: ${unmatched.join('; ')}`,
    ).toEqual([])
  })
})

describe('the enterprise profile is genuinely different', () => {
  it('uses EventBridge where zero uses SNS', () => {
    const zero = synth('zero', 'prod')
    const enterprise = synth('enterprise', 'prod')

    // Asserted by naming the DOMAIN bus rather than by counting topics. M0A-06 adds a
    // second SNS topic for provider commands, which is an SNS topic under both profiles
    // — publishes are free either way and PED S10.5's message-attribute filtering is an
    // SNS decision. Counting would have made this test fail for a change it has no
    // opinion about, and the usual response to that is to edit the number.
    const domainTopics = (template: Template): string[] =>
      Object.values(template.findResources('AWS::SNS::Topic')).map(resource =>
        String((resource as { Properties?: { TopicName?: string } }).Properties?.TopicName ?? ''),
      )

    expect(domainTopics(zero)).toContain('setlist-prod-domain')
    zero.resourceCountIs('AWS::Events::EventBus', 0)

    enterprise.resourceCountIs('AWS::Events::EventBus', 1)
    expect(domainTopics(enterprise)).not.toContain('setlist-prod-domain')
  })

  it('still synthesizes for every profile and environment', () => {
    // The enterprise path is not exercised by anything else, so it rots unless CI
    // builds it. Six combinations, every commit.
    for (const profile of PROFILES) {
      for (const envName of ENV_NAMES) {
        expect(() => synth(profile, envName)).not.toThrow()
      }
    }
  })
})
