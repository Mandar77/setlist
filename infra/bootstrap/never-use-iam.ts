/**
 * The never-use list, expressed as IAM.
 *
 * This is the third of the four layers that protect the budget (PED §2), and the only
 * one that holds when the others are bypassed: cdk-nag fails `cdk synth` and KICS scans
 * templates, but both are things CI runs, and both can be skipped by someone deploying
 * by hand. A permission boundary on the deploy role cannot be.
 *
 * ## What IAM can and cannot say
 *
 * IAM denies *actions*, and a good half of the never-use list is about *properties* —
 * a DynamoDB table's billing mode, a log group's retention, how many alarms exist. No
 * policy can express those. Pretending otherwise would be the worst outcome here: a
 * deny list that looks complete while silently covering two thirds of the list.
 *
 * So every entry in `budget.yaml`'s `never_use` appears in exactly one of two places
 * below — `DENIED_ACTIONS` or `NOT_EXPRESSIBLE_IN_IAM` — and `infra/test/bootstrap.test.ts`
 * fails if any entry is in neither, in both, or names an SZC rule that does not exist.
 * The second list is not an excuse; it is a record of precisely which guarantees rest
 * on the synth-time layers alone.
 */

/** One IAM deny, and the never-use entry it enforces. */
export interface DenyRule {
  /** Matches an entry in budget.yaml `never_use`. */
  readonly enforces: RegExp
  /** Human-readable reason, quoted in the template. */
  readonly why: string
  readonly actions: readonly string[]
  /**
   * Optional condition. Used where the action itself is legitimate and only one of its
   * shapes is not — creating a Lambda is fine, creating one inside a VPC is not.
   */
  readonly condition?: Record<string, Record<string, unknown>>
}

export const DENIED_ACTIONS: readonly DenyRule[] = [
  {
    enforces: /NAT Gateway/i,
    why: 'NAT gateways bill $0.045/hour with no free tier — about $32/month for existing.',
    actions: ['ec2:CreateNatGateway'],
  },
  {
    enforces: /EC2|RDS|ELB/i,
    why: 'EC2, RDS and load balancers bill by the hour whether or not anything uses them.',
    actions: [
      'ec2:RunInstances',
      'rds:CreateDBInstance',
      'rds:CreateDBCluster',
      'elasticloadbalancing:CreateLoadBalancer',
    ],
  },
  {
    enforces: /Lambda VpcConfig/i,
    why: 'A VPC-attached function needs an ENI, and egress from it needs a NAT gateway.',
    actions: ['lambda:CreateFunction', 'lambda:UpdateFunctionConfiguration'],
    // Creating a function is perfectly fine; creating one with subnets is not. The
    // `lambda:VpcIds` key is absent when there is no VpcConfig, so `Null: false` means
    // "this request specified a VPC".
    condition: { Null: { 'lambda:VpcIds': 'false' } },
  },
  {
    enforces: /provisioned concurrency/i,
    why: 'Billed hourly AND removes the function from the always-free Lambda allowance.',
    actions: ['lambda:PutProvisionedConcurrencyConfig'],
  },
  {
    enforces: /ECR/i,
    why: 'ECR storage is billed per GB-month after the first year, and images are large.',
    actions: ['ecr:CreateRepository'],
  },
  {
    enforces: /KMS::Key|KMS CMK|customer-managed/i,
    why: 'A customer-managed key is $1/month before a single request (PED D7).',
    actions: ['kms:CreateKey'],
  },
  {
    enforces: /Secrets Manager/i,
    why: '$0.40 per secret per month; SSM Parameter Store standard tier is free (PED D10-11).',
    actions: ['secretsmanager:CreateSecret'],
  },
  {
    enforces: /WAFv2/i,
    why: '$5/month per web ACL plus $1 per rule. Prod gets WAF free with CloudFront (PED D2).',
    actions: ['wafv2:CreateWebACL', 'wafv2:CreateRuleGroup', 'waf:CreateWebACL'],
  },
  {
    enforces: /Route 53/i,
    why: '$0.50 per hosted zone per month plus queries; the CloudFront domain is free.',
    actions: ['route53:CreateHostedZone'],
  },
  {
    enforces: /API Gateway/i,
    why: 'Credits-only on a post-2025-07-15 account. Function URLs behind CloudFront are free (PED D1).',
    // API Gateway authorises by HTTP verb, not by a CreateX action name.
    actions: ['apigateway:POST', 'apigateway:PUT'],
  },
  {
    enforces: /EventBridge buses/i,
    why: 'Custom bus events are $1/million with no free tier at all (PED D3).',
    actions: ['events:CreateEventBus'],
  },
  {
    enforces: /SQS event source mappings/i,
    why: 'An idle poller makes ~130k requests/month doing nothing (PED D5). Under profile=zero nothing uses an event source mapping, so this is a blanket deny.',
    actions: ['lambda:CreateEventSourceMapping'],
  },
  {
    enforces: /PITR/i,
    why: '$0.20 per GB-month of continuous backup, never covered by the free tier.',
    actions: ['dynamodb:UpdateContinuousBackups'],
  },
  {
    enforces: /Glue jobs/i,
    why: 'No Glue option reaches $0; the Data Catalog is free and is all this project uses (PED D8).',
    actions: ['glue:CreateJob', 'glue:StartJobRun', 'glue:CreateCrawler', 'glue:StartCrawler'],
  },
  {
    enforces: /Synthetics/i,
    why: 'Billed per canary run, and each one eats the 10-metric and 10-alarm allowances.',
    actions: ['synthetics:CreateCanary'],
  },
  {
    enforces: /FIS, Textract, Bedrock/i,
    why: 'All billed per call or per token with no free tier on a post-2025-07-15 account. CloudWatch GetMetricData and Logs Insights queries are billed per call too (CLAUDE.md).',
    actions: [
      'bedrock:*',
      'textract:*',
      'rekognition:*',
      'comprehend:*',
      'athena:*',
      'fis:*',
      'ses:*',
      'ce:GetCostAndUsage',
      'ce:GetCostForecast',
      'cloudwatch:GetMetricData',
      'logs:StartQuery',
    ],
  },
]

/**
 * Never-use entries no IAM policy can express, and what does enforce them instead.
 *
 * Each value names a rule in `infra/nag/rules.ts`, checked by the test — so this cannot
 * become a place where an entry is quietly parked with no enforcement anywhere.
 */
export const NOT_EXPRESSIBLE_IN_IAM: ReadonlyArray<{
  readonly enforces: RegExp
  readonly why: string
  readonly coveredBy: string
}> = [
  {
    enforces: /Express state machines/i,
    why: '`states:CreateStateMachine` carries no condition key for the workflow type, so IAM cannot tell Standard from Express.',
    coveredBy: 'SZC-SFN-EXPRESS',
  },
  {
    enforces: /PAY_PER_REQUEST/i,
    why: 'Billing mode is a property of the table, and `dynamodb:CreateTable` has no condition key for it.',
    coveredBy: 'SZC-DDB-ONDEMAND',
  },
  {
    enforces: /log groups without retention/i,
    why: 'Retention is set by a separate call after creation; denying creation would ban logging entirely.',
    coveredBy: 'SZC-LOG-RETENTION',
  },
  {
    enforces: /buckets without lifecycle/i,
    why: 'A lifecycle rule is a separate call after creation; denying `s3:CreateBucket` would ban storage entirely.',
    coveredBy: 'SZC-S3-LIFECYCLE',
  },
  {
    enforces: /alarms/i,
    why: 'A per-account count is not something a policy evaluating one request can know.',
    coveredBy: 'SZC-ALARM-BUDGET',
  },
]

/** Flattened action list, for the template and for `make preflight` output. */
export function allDeniedActions(): readonly string[] {
  return [...new Set(DENIED_ACTIONS.flatMap(rule => rule.actions))].sort()
}
