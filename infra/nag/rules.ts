/**
 * SZC rules — the $0 guarantee, expressed as checks against synthesized resources.
 *
 * Rules are DATA, not a pile of if-statements, for three reasons:
 *
 *   1. Every rule carries the never-use entry it enforces, so `pack.test.ts` can prove
 *      the rule set and `infra/free-tier/budget.yaml` have not drifted apart. A banned
 *      service added to the budget with no rule would otherwise leave the list looking
 *      enforced while nothing checked it.
 *   2. Each rule carries `why` — the actual charge. "NAT Gateway is banned" invites an
 *      argument; "$0.045/hour plus $0.045/GB, with no free tier" ends one.
 *   3. Fixtures are paired to rule ids, so a rule without both a violating and a
 *      compliant fixture fails the suite. A rule nobody has watched fire is a rule
 *      nobody knows works.
 *
 * Checks read the RENDERED CloudFormation properties rather than the typed L1
 * accessors. That distinction is not cosmetic: `addPropertyOverride('VpcConfig', ...)`
 * leaves `node.vpcConfig` undefined while putting VpcConfig straight into the template.
 * Reading the typed field would let any escape hatch walk past a cost gate — verified
 * here, and it is why two of these rules first passed their own violating fixtures.
 *
 * Severity is uniformly ERROR. There is no "slightly over $0".
 */

import { Stack } from 'aws-cdk-lib'
import type { CfnResource } from 'aws-cdk-lib'

/** Rendered CloudFormation properties for one resource. */
export type Props = Record<string, unknown>

/** What a rule gets to see beyond the resource itself. */
export interface RuleContext {
  /**
   * The properties this resource will actually have in the template, escape-hatch
   * overrides included.
   */
  readonly props: Props
  /**
   * 0-based position of this resource among resources of the same type in its stack,
   * ordered by construct path. Lets a rule express a per-stack budget — "the sixth
   * alarm" — while still being evaluated one resource at a time, which is the only
   * thing an Aspect can do.
   */
  readonly ordinal: number
  /** This environment's alarm share from budget.yaml. */
  readonly maxAlarms: number
}

/** A rule's verdict: true means the resource VIOLATES it. */
export type RuleCheck = (node: CfnResource, ctx: RuleContext) => boolean

export interface SzcRule {
  /** Stable id. Appears in CI output and in suppressions, so it must not churn. */
  readonly id: string
  readonly title: string
  /** The actual cost of taking this. Quoted in the failure message. */
  readonly why: string
  /**
   * Which `never_use` entry in budget.yaml this enforces. The drift test matches on
   * this, so a rule and its budget line stay tied together.
   */
  readonly enforces: RegExp
  readonly check: RuleCheck
}

/** Narrow an unknown property to an object so nested lookups stay type-safe. */
function obj(value: unknown): Props {
  return typeof value === 'object' && value !== null ? (value as Props) : {}
}

/** Whether a rendered property was set at all. */
function present(value: unknown): boolean {
  return value !== undefined && value !== null
}

/**
 * The properties this resource will actually have in the template.
 *
 * `_toCloudFormation` is internal, but it is the only view that includes raw property
 * overrides — and the template is what gets deployed, so it is the only view that
 * matters for a cost gate.
 */
export function renderedProps(node: CfnResource): Props {
  try {
    const toCfn = (node as unknown as { _toCloudFormation(): unknown })._toCloudFormation()
    const resources = obj(obj(Stack.of(node).resolve(toCfn))['Resources'])
    return obj(obj(Object.values(resources)[0])['Properties'])
  } catch {
    // A resource that cannot be rendered cannot be judged. Abstaining is only safe
    // because `make preflight` also asserts against finished templates; if this ever
    // becomes the single check, it stops being safe.
    return {}
  }
}

/** Collect the logical ids a rendered value points at, through Ref and Fn::GetAtt. */
function collectRefs(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, into)
    return
  }
  if (typeof value !== 'object' || value === null) return

  for (const [key, nested] of Object.entries(value as Props)) {
    if (key === 'Ref' && typeof nested === 'string') {
      into.add(nested)
    } else if (key === 'Fn::GetAtt' && Array.isArray(nested) && typeof nested[0] === 'string') {
      into.add(nested[0])
    } else {
      collectRefs(nested, into)
    }
  }
}

/**
 * The CloudFormation resource types a rendered property value refers to.
 *
 * A cross-resource property is almost always an unresolved `Fn::GetAtt`, so matching
 * the ARN as text only works for imported resources. Following the reference to the
 * construct it names is what lets a rule say "this points at a queue" rather than
 * guessing from a logical id like `Q63C6E3AB`.
 */
export function typesReferencedBy(node: CfnResource, value: unknown): readonly string[] {
  const ids = new Set<string>()
  collectRefs(value, ids)
  if (ids.size === 0) return []

  const stack = Stack.of(node)
  const types: string[] = []
  for (const peer of stack.node.findAll()) {
    if (!('cfnResourceType' in peer)) continue
    const resource = peer as CfnResource
    if (ids.has(String(stack.resolve(resource.logicalId)))) {
      types.push(resource.cfnResourceType)
    }
  }
  return types
}

/** Bans one or more CloudFormation resource types outright. */
function bansTypes(...types: readonly string[]): RuleCheck {
  return node => types.includes(node.cfnResourceType)
}

export const SZC_RULES: readonly SzcRule[] = [
  {
    id: 'SZC-NAT',
    title: 'No NAT gateways',
    why: '$0.045/hour plus $0.045/GB processed, billed from the moment it exists and with no free tier. One forgotten NAT gateway is about $32/month on its own.',
    enforces: /NAT Gateway/i,
    check: bansTypes('AWS::EC2::NatGateway'),
  },
  {
    id: 'SZC-COMPUTE',
    title: 'No EC2, RDS or load balancers',
    why: 'All three bill by the hour whether or not anything uses them. The architecture is serverless precisely so that an idle environment costs nothing.',
    enforces: /EC2|RDS|ELB/i,
    check: bansTypes(
      'AWS::EC2::Instance',
      'AWS::RDS::DBInstance',
      'AWS::RDS::DBCluster',
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      'AWS::ElasticLoadBalancing::LoadBalancer',
    ),
  },
  {
    id: 'SZC-LAMBDA-VPC',
    title: 'No Lambda in a VPC',
    why: 'A VPC-attached function needs an ENI, and any egress from it needs a NAT gateway — so this quietly pulls in the $32/month SZC-NAT charge behind a property nobody reads.',
    enforces: /Lambda VpcConfig/i,
    check: (node, { props }) =>
      node.cfnResourceType === 'AWS::Lambda::Function' && present(props['VpcConfig']),
  },
  {
    id: 'SZC-LAMBDA-PROVISIONED',
    title: 'No provisioned concurrency',
    why: 'Billed hourly for the reservation, and it takes the function out of the always-free Lambda allowance entirely — so it costs twice: once to reserve, once for invocations that used to be free.',
    enforces: /provisioned concurrency/i,
    check: (node, { props }) =>
      (node.cfnResourceType === 'AWS::Lambda::Version' ||
        node.cfnResourceType === 'AWS::Lambda::Alias') &&
      present(props['ProvisionedConcurrencyConfig']),
  },
  {
    id: 'SZC-LAMBDA-IMAGE',
    title: 'No container-image Lambdas',
    why: 'An image package needs an ECR repository, and ECR storage is billed per GB-month once the 12-month allowance ends. Zip packaging carries no storage charge at all.',
    enforces: /ECR/i,
    check: (node, { props }) =>
      node.cfnResourceType === 'AWS::Lambda::Function' &&
      (props['PackageType'] === 'Image' || present(obj(props['Code'])['ImageUri'])),
  },
  {
    id: 'SZC-ECR',
    title: 'No ECR repositories',
    why: 'Storage is billed per GB-month with only a 12-month, 500MB free allowance, and a single image is hundreds of megabytes.',
    enforces: /ECR/i,
    check: bansTypes('AWS::ECR::Repository'),
  },
  {
    id: 'SZC-KMS-CMK',
    title: 'No customer-managed KMS keys',
    why: '$1 per key per month before a single request is made. The token vault uses an AES-GCM data key held in an SSM SecureString instead (PED D7).',
    enforces: /KMS::Key|KMS CMK|customer-managed/i,
    check: bansTypes('AWS::KMS::Key'),
  },
  {
    id: 'SZC-SECRETS-MANAGER',
    title: 'No Secrets Manager secrets',
    why: '$0.40 per secret per month. At 10k users holding a refresh token each that is roughly $4,000/month; SSM Parameter Store standard tier is free (PED D10-11).',
    enforces: /Secrets Manager/i,
    check: bansTypes('AWS::SecretsManager::Secret'),
  },
  {
    id: 'SZC-WAF',
    title: 'No standalone WAF',
    why: '$5/month per web ACL plus $1 per rule and a charge per million requests. Prod gets WAF bundled at no extra cost with the CloudFront flat-rate plan (PED D2).',
    enforces: /WAFv2/i,
    check: bansTypes('AWS::WAFv2::WebACL', 'AWS::WAFv2::RuleGroup', 'AWS::WAF::WebACL'),
  },
  {
    id: 'SZC-ROUTE53',
    title: 'No Route 53 hosted zones',
    why: '$0.50 per hosted zone per month plus per-query charges, and hosted zones appear in no free tier. The CloudFront default domain costs nothing.',
    enforces: /Route 53/i,
    check: bansTypes('AWS::Route53::HostedZone'),
  },
  {
    id: 'SZC-APIGW',
    title: 'No API Gateway',
    why: "API Gateway's free tier is 12-month/credits-only for accounts opened after 2025-07-15, after which it bills per million requests. Lambda Function URLs behind CloudFront are always free (PED D1).",
    enforces: /API Gateway/i,
    check: bansTypes('AWS::ApiGateway::RestApi', 'AWS::ApiGatewayV2::Api', 'AWS::Serverless::Api'),
  },
  {
    id: 'SZC-EVENTBUS',
    title: 'No custom EventBridge buses',
    why: 'Custom bus events are $1 per million published with no free tier whatsoever — only AWS-service management events are free. SNS gives a million publishes a month free instead (PED D3).',
    enforces: /EventBridge buses/i,
    check: bansTypes('AWS::Events::EventBus'),
  },
  {
    id: 'SZC-SFN-EXPRESS',
    title: 'No Express state machines',
    why: 'Express workflows bill per request and per GB-second with no free tier. Standard has 4,000 free transitions a month, which is why batch uses Standard and the hot path uses a Lambda saga (PED D4).',
    enforces: /Express state machines/i,
    check: (node, { props }) =>
      node.cfnResourceType === 'AWS::StepFunctions::StateMachine' &&
      props['StateMachineType'] === 'EXPRESS',
  },
  {
    id: 'SZC-SQS-ESM',
    title: 'No SQS event source mappings',
    why: 'An idle poller at a 20-second long poll makes about 130k requests/month doing nothing, and Lambda runs up to five pollers per mapping. Eight queues across three environments exhaust the 1M free requests at zero traffic (PED D5).',
    enforces: /SQS event source mappings/i,
    check: (node, { props }) => {
      if (node.cfnResourceType !== 'AWS::Lambda::EventSourceMapping') return false
      const arn = props['EventSourceArn']
      // An imported queue gives a literal ARN; one declared in the same stack gives an
      // Fn::GetAtt, which says nothing on its own — the logical id of `new Queue(s,
      // 'Q')` is `Q63C6E3AB`. Following the reference is what makes this rule work in
      // the case it exists for.
      if (JSON.stringify(arn ?? '').includes(':sqs:')) return true
      return typesReferencedBy(node, arn).includes('AWS::SQS::Queue')
    },
  },
  {
    id: 'SZC-DDB-ONDEMAND',
    title: 'No on-demand DynamoDB',
    why: 'PAY_PER_REQUEST bills per million reads and writes from the first request. The free allowance is 25 WCU/25 RCU of PROVISIONED capacity, shared account-wide across every table and index (PED D6).',
    enforces: /PAY_PER_REQUEST/i,
    check: (node, { props }) =>
      (node.cfnResourceType === 'AWS::DynamoDB::Table' ||
        node.cfnResourceType === 'AWS::DynamoDB::GlobalTable') &&
      props['BillingMode'] === 'PAY_PER_REQUEST',
  },
  {
    id: 'SZC-DDB-PITR',
    title: 'No point-in-time recovery',
    why: '$0.20 per GB-month of continuous backup, charged on top of table storage and never covered by the free tier. Everything in these tables is reconstructible from the source text.',
    enforces: /PITR/i,
    check: (node, { props }) => {
      const enabled = (spec: unknown): boolean => obj(spec)['PointInTimeRecoveryEnabled'] === true

      if (node.cfnResourceType === 'AWS::DynamoDB::Table') {
        return enabled(props['PointInTimeRecoverySpecification'])
      }
      if (node.cfnResourceType === 'AWS::DynamoDB::GlobalTable') {
        const replicas = Array.isArray(props['Replicas']) ? props['Replicas'] : []
        return replicas.some(replica => enabled(obj(replica)['PointInTimeRecoverySpecification']))
      }
      return false
    },
  },
  {
    id: 'SZC-AUTOSCALING',
    title: 'No Application Auto Scaling',
    why: 'Target-tracking policies create CloudWatch alarms AT RUNTIME, in the account and not in the template, so they consume the 10-alarm free allowance (7 of which are already budgeted) where no template-shaped gate can see them. DynamoDB capacity inside the free allowance is free whether used or not, so there is nothing to scale down to (ADR-013).',
    enforces: /auto ?scaling/i,
    check: (node, { props }) => {
      if (
        node.cfnResourceType === 'AWS::ApplicationAutoScaling::ScalableTarget' ||
        node.cfnResourceType === 'AWS::ApplicationAutoScaling::ScalingPolicy'
      ) {
        return true
      }
      // The second shape, and the reason this rule is not a `bansTypes`. A `TableV2`
      // renders AWS::DynamoDB::GlobalTable and carries autoscaling INLINE, emitting no
      // ApplicationAutoScaling resource at all — so a type ban is satisfied by a table
      // that autoscales. `never-use.test.ts` passed for two months on exactly that gap.
      if (
        node.cfnResourceType !== 'AWS::DynamoDB::Table' &&
        node.cfnResourceType !== 'AWS::DynamoDB::GlobalTable'
      ) {
        return false
      }
      return /(Read|Write)CapacityAutoScalingSettings/.test(JSON.stringify(props))
    },
  },
  {
    id: 'SZC-GLUE',
    title: 'No Glue jobs or crawlers',
    why: 'No Glue option reaches $0 — the cheapest Python shell job bills 1/16 DPU-hour at a one-minute minimum and Spark bills two full DPUs. The Data Catalog is free and is all this project uses; ETL runs as a Lambda (PED D8).',
    enforces: /Glue jobs/i,
    check: bansTypes('AWS::Glue::Job', 'AWS::Glue::Crawler', 'AWS::Glue::Trigger'),
  },
  {
    id: 'SZC-LOG-RETENTION',
    title: 'Every log group needs explicit retention',
    why: 'The 5GB free allowance covers ingest only; stored logs accrue at $0.03 per GB-month forever. A log group with no retention is a bill that grows on its own.',
    enforces: /log groups without retention/i,
    check: (node, { props }) =>
      node.cfnResourceType === 'AWS::Logs::LogGroup' && !present(props['RetentionInDays']),
  },
  {
    id: 'SZC-S3-LIFECYCLE',
    title: 'Every bucket needs a lifecycle rule',
    why: 'S3 is credits-only for accounts opened after 2025-07-15, so at $0.023 per GB-month objects that are never expired become a recurring charge the moment credits run out.',
    enforces: /buckets without lifecycle/i,
    check: (node, { props }) => {
      if (node.cfnResourceType !== 'AWS::S3::Bucket') return false
      const rules = obj(props['LifecycleConfiguration'])['Rules']
      return !Array.isArray(rules) || rules.length === 0
    },
  },
  {
    id: 'SZC-SYNTHETICS',
    title: 'No CloudWatch Synthetics canaries',
    why: '$0.0012 per canary run — about $5/month at one-minute intervals — and every canary also eats into the 10-metric and 10-alarm free allowances.',
    enforces: /Synthetics/i,
    check: bansTypes('AWS::Synthetics::Canary'),
  },
  {
    id: 'SZC-ALARM-BUDGET',
    title: 'No more alarms than this environment is budgeted',
    why: 'Ten alarms are free account-wide, shared across all three environments; the eleventh costs $0.10/month and so does every one after it. Per-environment shares live in budget.yaml — prod 5, stage 2, dev 0 (PED §11).',
    enforces: /alarms/i,
    // `ordinal` is this alarm's position among the alarms in its stack, so the rule
    // fires on the ones past the budget rather than on all of them. The failure then
    // names an alarm to remove instead of only reporting that there are too many.
    //
    // Read through `ctx` rather than destructuring: `ordinal` is a lazy getter, and
    // destructuring in the parameter list would force the stack walk for every
    // resource in the tree instead of only for alarms.
    check: (node, ctx) =>
      node.cfnResourceType === 'AWS::CloudWatch::Alarm' && ctx.ordinal >= ctx.maxAlarms,
  },
  {
    id: 'SZC-BANNED-SERVICE-IAM',
    title: 'No IAM grants for banned services',
    why: 'Bedrock, Textract, Rekognition, Athena, Cost Explorer ($0.01 per request), FIS and SES bill per call or per token with no free tier on a post-2025-07-15 account. A grant is how one of them ends up being called.',
    enforces: /FIS, Textract, Bedrock/i,
    check: (node, { props }) => {
      if (
        node.cfnResourceType !== 'AWS::IAM::Policy' &&
        node.cfnResourceType !== 'AWS::IAM::Role'
      ) {
        return false
      }
      return /"(bedrock|textract|rekognition|athena|ce|fis|ses|comprehend):[A-Za-z*]/i.test(
        JSON.stringify(props),
      )
    },
  },
] as const

/** Rule ids, for suppressions and for the fixture coverage check. */
export const SZC_RULE_IDS: readonly string[] = SZC_RULES.map(rule => rule.id)
