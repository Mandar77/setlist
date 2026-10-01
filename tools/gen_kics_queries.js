// Generate the zero-cost KICS query pack from one spec.
//
//   node tools/gen_kics_queries.js          # write security/kics-queries/zero-cost/
//   node tools/gen_kics_queries.js --check   # fail if the tree is out of date
//
// ## Why generated
//
// KICS wants a directory per query holding metadata.json and query.rego, and this pack
// needs a positive and a negative sample for each one too. That is four files times
// twenty-one rules, every one of which has to agree with `infra/nag/rules.ts` — the
// cdk-nag pack enforcing the same list at synth time.
//
// Hand-maintained, those two lists drift within a month, and the drift is silent in the
// worst direction: a rule that exists in one place and not the other looks enforced from
// either side. So the spec below is the source, the files are output, and `--check`
// fails the build when they disagree. `infra/nag/test/kics-parity.test.ts` closes the
// loop by asserting this spec and SZC_RULES name exactly the same rule ids.
//
// Numbers come from `infra/free-tier/budget.yaml` rather than being written here, for
// the same reason everything else in this repo reads that file.

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const outDir = join(repoRoot, 'security', 'kics-queries', 'zero-cost')

// pnpm hoists nothing, so `yaml` is resolvable from infra (which depends on it) but not
// from the repo root. Reaching for it there beats adding a root dependency for one
// number.
const { parse } = createRequire(join(repoRoot, 'infra', 'package.json'))('yaml')

const budget = parse(readFileSync(join(repoRoot, 'infra', 'free-tier', 'budget.yaml'), 'utf8'))
/** Alarms are free up to this count account-wide; the eleventh is billed. */
const ALARM_CEILING = budget.limits.cloudwatch_alarms.total

/**
 * KICS identifies a query by UUID. Deriving it from the SZC id keeps it stable across
 * regenerations without anyone having to mint and track twenty-one of them by hand.
 */
function stableUuid(seed) {
  const h = createHash('sha1').update(`setlist-zero-cost:${seed}`).digest()
  const b = Buffer.from(h.subarray(0, 16))
  b[6] = (b[6] & 0x0f) | 0x50 // version 5
  b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant
  const hex = b.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const res = (type, properties = {}) => ({ Type: type, Properties: properties })
const template = resources => ({ AWSTemplateFormatVersion: '2010-09-09', Resources: resources })

/** A lambda that is fine on every rule, used as filler in samples. */
const okLambda = res('AWS::Lambda::Function', {
  Handler: 'index.handler',
  Runtime: 'nodejs22.x',
  Role: { 'Fn::GetAtt': ['Role', 'Arn'] },
  Code: { ZipFile: 'exports.handler = async () => {}' },
})

/** A log group and bucket need explicit compliance, so filler cannot be bare. */
const okLogGroup = res('AWS::Logs::LogGroup', { RetentionInDays: 3 })

/**
 * Every rule. `types` bans resource types outright; `body` is extra Rego for the ones
 * that turn on a property. Both forms produce the same result block.
 */
const QUERIES = [
  {
    id: 'SZC-NAT',
    slug: 'no_nat_gateway',
    name: 'NAT Gateway Is Never Free',
    why: '$0.045/hour plus $0.045/GB processed, billed from creation with no free tier — about $32/month for existing.',
    types: ['AWS::EC2::NatGateway'],
    positive: { Nat: res('AWS::EC2::NatGateway', { SubnetId: 'subnet-1', AllocationId: 'eip-1' }) },
  },
  {
    id: 'SZC-COMPUTE',
    slug: 'no_always_on_compute',
    name: 'EC2, RDS And Load Balancers Bill By The Hour',
    why: 'All three bill whether or not anything uses them; the architecture is serverless so that idle costs nothing.',
    types: [
      'AWS::EC2::Instance',
      'AWS::RDS::DBInstance',
      'AWS::RDS::DBCluster',
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      'AWS::ElasticLoadBalancing::LoadBalancer',
    ],
    positive: { Box: res('AWS::EC2::Instance', { ImageId: 'ami-1' }) },
  },
  {
    id: 'SZC-LAMBDA-VPC',
    slug: 'no_lambda_vpc_config',
    name: 'Lambda In A VPC Pulls In A NAT Gateway',
    why: 'A VPC-attached function needs an ENI, and egress from it needs a NAT gateway — the $32/month charge behind a property nobody reads.',
    body: ['resource.Type == "AWS::Lambda::Function"', 'resource.Properties.VpcConfig'],
    searchKey: 'Resources.%s.Properties.VpcConfig',
    positive: {
      Fn: res('AWS::Lambda::Function', {
        Handler: 'index.handler',
        Runtime: 'nodejs22.x',
        Role: { 'Fn::GetAtt': ['Role', 'Arn'] },
        Code: { ZipFile: 'x' },
        VpcConfig: { SubnetIds: ['subnet-1'], SecurityGroupIds: ['sg-1'] },
      }),
    },
  },
  {
    id: 'SZC-LAMBDA-PROVISIONED',
    slug: 'no_provisioned_concurrency',
    name: 'Provisioned Concurrency Leaves The Free Allowance',
    why: 'Billed hourly for the reservation AND removes the function from the always-free Lambda allowance, so it costs twice.',
    body: [
      'types := {"AWS::Lambda::Version", "AWS::Lambda::Alias"}',
      'types[resource.Type]',
      'resource.Properties.ProvisionedConcurrencyConfig',
    ],
    searchKey: 'Resources.%s.Properties.ProvisionedConcurrencyConfig',
    positive: {
      Ver: res('AWS::Lambda::Version', {
        FunctionName: 'fn',
        ProvisionedConcurrencyConfig: { ProvisionedConcurrentExecutions: 1 },
      }),
    },
  },
  {
    id: 'SZC-LAMBDA-IMAGE',
    slug: 'no_container_image_lambda',
    name: 'Container-Image Lambdas Require Billed ECR Storage',
    why: 'An image package needs an ECR repository, billed per GB-month after the first year. Zip packaging has no storage charge.',
    body: [
      'resource.Type == "AWS::Lambda::Function"',
      'resource.Properties.PackageType == "Image"',
    ],
    searchKey: 'Resources.%s.Properties.PackageType',
    positive: {
      Fn: res('AWS::Lambda::Function', {
        PackageType: 'Image',
        Role: { 'Fn::GetAtt': ['Role', 'Arn'] },
        Code: { ImageUri: 'example.dkr.ecr.us-east-1.amazonaws.com/x:latest' },
      }),
    },
  },
  {
    id: 'SZC-ECR',
    slug: 'no_ecr_repository',
    name: 'ECR Storage Is Billed Per GB-Month',
    why: 'Only a 12-month, 500MB free allowance, and a single image is hundreds of megabytes.',
    types: ['AWS::ECR::Repository'],
    positive: { Repo: res('AWS::ECR::Repository', { RepositoryName: 'x' }) },
  },
  {
    id: 'SZC-KMS-CMK',
    slug: 'no_customer_managed_key',
    name: 'A Customer-Managed KMS Key Costs $1/Month',
    why: '$1 per key per month before a single request. The token vault uses an AES-GCM data key in an SSM SecureString instead (PED D7).',
    types: ['AWS::KMS::Key'],
    positive: { Cmk: res('AWS::KMS::Key', { KeyPolicy: {} }) },
  },
  {
    id: 'SZC-SECRETS-MANAGER',
    slug: 'no_secrets_manager',
    name: 'Secrets Manager Costs $0.40 Per Secret Per Month',
    why: 'At 10k users holding a refresh token each that is roughly $4,000/month; SSM Parameter Store standard tier is free (PED D10-11).',
    types: ['AWS::SecretsManager::Secret'],
    positive: { S: res('AWS::SecretsManager::Secret', { Name: 'x' }) },
  },
  {
    id: 'SZC-WAF',
    slug: 'no_standalone_waf',
    name: 'Standalone WAF Is Billed Per ACL And Per Rule',
    why: '$5/month per web ACL plus $1 per rule. Prod gets WAF bundled free with the CloudFront flat-rate plan (PED D2).',
    types: ['AWS::WAFv2::WebACL', 'AWS::WAFv2::RuleGroup', 'AWS::WAF::WebACL'],
    positive: { Acl: res('AWS::WAFv2::WebACL', { Scope: 'CLOUDFRONT' }) },
  },
  {
    id: 'SZC-ROUTE53',
    slug: 'no_route53_hosted_zone',
    name: 'A Hosted Zone Costs $0.50/Month Plus Queries',
    why: 'Hosted zones appear in no free tier. The CloudFront default domain costs nothing.',
    types: ['AWS::Route53::HostedZone'],
    positive: { Zone: res('AWS::Route53::HostedZone', { Name: 'example.com' }) },
  },
  {
    id: 'SZC-APIGW',
    slug: 'no_api_gateway',
    name: 'API Gateway Is Credits-Only On A Post-2025-07-15 Account',
    why: 'Its free tier is 12-month/credits-only for accounts opened after 2025-07-15. Lambda Function URLs behind CloudFront are always free (PED D1).',
    types: ['AWS::ApiGateway::RestApi', 'AWS::ApiGatewayV2::Api', 'AWS::Serverless::Api'],
    positive: { Api: res('AWS::ApiGatewayV2::Api', { Name: 'x', ProtocolType: 'HTTP' }) },
  },
  {
    id: 'SZC-EVENTBUS',
    slug: 'no_custom_event_bus',
    name: 'Custom EventBridge Buses Have No Free Tier At All',
    why: '$1 per million events published; only AWS-service management events are free. SNS gives a million publishes a month free (PED D3).',
    types: ['AWS::Events::EventBus'],
    positive: { Bus: res('AWS::Events::EventBus', { Name: 'x' }) },
  },
  {
    id: 'SZC-SFN-EXPRESS',
    slug: 'no_express_state_machine',
    name: 'Express Workflows Have No Free Tier',
    why: 'Billed per request and per GB-second. Standard has 4,000 free transitions a month, which is why batch uses Standard (PED D4).',
    body: [
      'resource.Type == "AWS::StepFunctions::StateMachine"',
      'resource.Properties.StateMachineType == "EXPRESS"',
    ],
    searchKey: 'Resources.%s.Properties.StateMachineType',
    positive: {
      Sm: res('AWS::StepFunctions::StateMachine', {
        StateMachineType: 'EXPRESS',
        DefinitionString: '{}',
        RoleArn: { 'Fn::GetAtt': ['Role', 'Arn'] },
      }),
    },
    negative: {
      Sm: res('AWS::StepFunctions::StateMachine', {
        StateMachineType: 'STANDARD',
        DefinitionString: '{}',
        RoleArn: { 'Fn::GetAtt': ['Role', 'Arn'] },
      }),
    },
  },
  {
    id: 'SZC-SQS-ESM',
    slug: 'no_sqs_event_source_mapping',
    name: 'An Idle SQS Poller Spends The Request Allowance',
    why: 'A 20-second long poll makes ~130k requests/month doing nothing, and Lambda runs up to five pollers per mapping (PED D5).',
    body: [
      'resource.Type == "AWS::Lambda::EventSourceMapping"',
      'arn := resource.Properties.EventSourceArn',
      'contains(lower(json.marshal(arn)), "sqs")',
    ],
    searchKey: 'Resources.%s.Properties.EventSourceArn',
    positive: {
      Esm: res('AWS::Lambda::EventSourceMapping', {
        FunctionName: 'fn',
        // No account segment. What the query keys on is `:sqs:`, and any twelve-digit
        // run after an ARN prefix is flagged by tools/check_no_secrets.py — correctly,
        // since it cannot tell a placeholder from a real id and should not try.
        EventSourceArn: 'arn:aws:sqs:us-east-1::domain-dlq',
      }),
    },
  },
  {
    id: 'SZC-DDB-ONDEMAND',
    slug: 'no_on_demand_dynamodb',
    name: 'PAY_PER_REQUEST DynamoDB Is Billed From The First Request',
    why: 'The free allowance is 25 WCU/25 RCU of PROVISIONED capacity, shared account-wide across every table and index (PED D6).',
    body: [
      'types := {"AWS::DynamoDB::Table", "AWS::DynamoDB::GlobalTable"}',
      'types[resource.Type]',
      'resource.Properties.BillingMode == "PAY_PER_REQUEST"',
    ],
    searchKey: 'Resources.%s.Properties.BillingMode',
    positive: {
      T: res('AWS::DynamoDB::Table', {
        BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
      }),
    },
  },
  {
    id: 'SZC-DDB-PITR',
    slug: 'no_point_in_time_recovery',
    name: 'Point-In-Time Recovery Is Billed Per GB Of Backup',
    why: '$0.20 per GB-month of continuous backup, never covered by the free tier. This data is reconstructible from the source text.',
    body: [
      'resource.Type == "AWS::DynamoDB::Table"',
      'resource.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled == true',
    ],
    searchKey: 'Resources.%s.Properties.PointInTimeRecoverySpecification',
    positive: {
      T: res('AWS::DynamoDB::Table', {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
      }),
    },
  },
  {
    id: 'SZC-GLUE',
    slug: 'no_glue_jobs',
    name: 'No Glue Option Reaches $0',
    why: 'The cheapest Python shell job bills 1/16 DPU-hour at a one-minute minimum. The Data Catalog is free and is all this project uses (PED D8).',
    types: ['AWS::Glue::Job', 'AWS::Glue::Crawler', 'AWS::Glue::Trigger'],
    positive: { Job: res('AWS::Glue::Job', { Command: { Name: 'pythonshell' }, Role: 'r' }) },
  },
  {
    id: 'SZC-LOG-RETENTION',
    slug: 'log_group_without_retention',
    name: 'A Log Group Without Retention Is A Bill That Grows',
    why: 'The 5GB free allowance covers ingest only; stored logs accrue at $0.03 per GB-month forever.',
    body: ['resource.Type == "AWS::Logs::LogGroup"', 'not resource.Properties.RetentionInDays'],
    searchKey: 'Resources.%s.Properties',
    positive: { Logs: res('AWS::Logs::LogGroup', { LogGroupName: '/x' }) },
    negative: { Logs: okLogGroup },
  },
  {
    id: 'SZC-S3-LIFECYCLE',
    slug: 'bucket_without_lifecycle',
    name: 'A Bucket Without A Lifecycle Rule Never Expires Anything',
    why: 'S3 is credits-only for accounts opened after 2025-07-15, so unexpired objects become a recurring charge once credits run out.',
    body: [
      'resource.Type == "AWS::S3::Bucket"',
      'not resource.Properties.LifecycleConfiguration.Rules',
    ],
    searchKey: 'Resources.%s.Properties',
    positive: { B: res('AWS::S3::Bucket', { BucketName: 'x' }) },
    negative: {
      B: res('AWS::S3::Bucket', {
        LifecycleConfiguration: { Rules: [{ Status: 'Enabled', ExpirationInDays: 1 }] },
      }),
    },
  },
  {
    id: 'SZC-SYNTHETICS',
    slug: 'no_synthetics_canary',
    name: 'Synthetics Canaries Are Billed Per Run',
    why: '$0.0012 per run — about $5/month at one-minute intervals — and each canary also eats the 10-metric and 10-alarm allowances.',
    types: ['AWS::Synthetics::Canary'],
    positive: { C: res('AWS::Synthetics::Canary', { Name: 'x', RuntimeVersion: 'syn-nodejs' }) },
  },
  {
    id: 'SZC-ALARM-BUDGET',
    slug: 'too_many_alarms',
    name: `More Than ${ALARM_CEILING} Alarms Is Billed Per Alarm`,
    why: `${ALARM_CEILING} alarms are free account-wide across all three environments; the next one costs $0.10/month and so does every one after it (PED S11).`,
    // KICS sees one template at a time and has no idea which environment it is, so this
    // enforces the account-wide ceiling. The per-environment shares are checked by
    // SZC-ALARM-BUDGET in the cdk-nag pack, which does know.
    body: [
      'resource.Type == "AWS::CloudWatch::Alarm"',
      'alarms := [n | input.document[i].Resources[n].Type == "AWS::CloudWatch::Alarm"]',
      `count(alarms) > ${ALARM_CEILING}`,
    ],
    searchKey: 'Resources.%s.Type',
    positive: Object.fromEntries(
      Array.from({ length: ALARM_CEILING + 1 }, (_, n) => [
        `Alarm${n}`,
        res('AWS::CloudWatch::Alarm', {
          ComparisonOperator: 'GreaterThanThreshold',
          EvaluationPeriods: 1,
          Threshold: 1,
        }),
      ]),
    ),
    negative: Object.fromEntries(
      Array.from({ length: ALARM_CEILING }, (_, n) => [
        `Alarm${n}`,
        res('AWS::CloudWatch::Alarm', {
          ComparisonOperator: 'GreaterThanThreshold',
          EvaluationPeriods: 1,
          Threshold: 1,
        }),
      ]),
    ),
  },
  {
    id: 'SZC-BANNED-SERVICE-IAM',
    slug: 'no_banned_service_grants',
    name: 'IAM Grants For Services With No Free Tier',
    why: 'Bedrock, Textract, Rekognition, Athena, Cost Explorer, FIS and SES bill per call or per token. A grant is how one of them ends up being called.',
    body: [
      'types := {"AWS::IAM::Policy", "AWS::IAM::Role"}',
      'types[resource.Type]',
      'banned := {"bedrock", "textract", "rekognition", "athena", "ce", "fis", "ses", "comprehend"}',
      'action := walk_actions(resource)',
      'service := split(action, ":")[0]',
      'banned[lower(service)]',
    ],
    searchKey: 'Resources.%s.Properties',
    helpers: [
      '# Actions live at different depths in Policy and Role, and may be a string or a',
      '# list. Walking the whole resource is the only form that catches both without',
      '# enumerating every shape CloudFormation allows.',
      'walk_actions(resource) = action {',
      '\twalk(resource, [_, value])',
      '\tis_string(value.Action)',
      '\taction := value.Action',
      '}',
      '',
      'walk_actions(resource) = action {',
      '\twalk(resource, [_, value])',
      '\tis_array(value.Action)',
      '\taction := value.Action[_]',
      '}',
    ],
    positive: {
      Role: res('AWS::IAM::Role', {
        AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] },
        Policies: [
          {
            PolicyName: 'p',
            PolicyDocument: {
              Version: '2012-10-17',
              Statement: [{ Effect: 'Allow', Action: 'bedrock:InvokeModel', Resource: '*' }],
            },
          },
        ],
      }),
    },
    negative: {
      Role: res('AWS::IAM::Role', {
        AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] },
        Policies: [
          {
            PolicyName: 'p',
            PolicyDocument: {
              Version: '2012-10-17',
              Statement: [{ Effect: 'Allow', Action: ['sns:Publish'], Resource: '*' }],
            },
          },
        ],
      }),
    },
  },
]

/** The Rego for one query. */
function rego(q) {
  const conditions = q.types
    ? [`banned := {${q.types.map(t => `"${t}"`).join(', ')}}`, 'banned[resource.Type]']
    : q.body

  const searchKey = q.searchKey ?? 'Resources.%s.Type'
  const lines = [
    `# ${q.id} — ${q.name}`,
    '#',
    `# ${q.why}`,
    '#',
    '# GENERATED by tools/gen_kics_queries.js. Edit the spec there, not this file.',
    '# The same rule is enforced at synth time by infra/nag/rules.ts; a parity test',
    '# asserts the two lists name the same rule ids.',
    '',
    'package Cx',
    '',
    'import data.generic.cloudformation as cf_lib',
    '',
  ]
  if (q.helpers) lines.push(...q.helpers, '')
  lines.push(
    'CxPolicy[result] {',
    '\tresource := input.document[i].Resources[name]',
    ...conditions.map(c => `\t${c}`),
    '',
    '\tresult := {',
    '\t\t"documentId": input.document[i].id,',
    '\t\t"resourceType": resource.Type,',
    '\t\t"resourceName": cf_lib.get_resource_name(resource, name),',
    `\t\t"searchKey": sprintf("${searchKey}", [name]),`,
    '\t\t"issueType": "IncorrectValue",',
    `\t\t"keyExpectedValue": sprintf("Resources.%s should not cost money under profile=zero (${q.id})", [name]),`,
    `\t\t"keyActualValue": sprintf("Resources.%s is billable: ${q.why.replace(/"/g, "'")}", [name]),`,
    '\t}',
    '}',
    '',
  )
  return lines.join('\n')
}

function metadata(q) {
  return `${JSON.stringify(
    {
      id: stableUuid(q.id),
      queryName: q.name,
      severity: 'HIGH',
      category: 'Resource Management',
      descriptionText: `${q.why} Enforced as ${q.id}.`,
      descriptionUrl: 'https://github.com/setlist/setlist/blob/main/infra/free-tier/budget.yaml',
      platform: 'CloudFormation',
      descriptionID: stableUuid(q.id).slice(0, 8),
      cloudProvider: 'aws',
      szcRule: q.id,
    },
    null,
    2,
  )}\n`
}

/** A negative sample must be clean against EVERY query, since they are scanned together. */
function negativeFor(q) {
  return q.negative ?? { Fn: okLambda, Logs: okLogGroup }
}

const files = new Map()
for (const q of QUERIES) {
  const dir = q.slug
  files.set(`${dir}/metadata.json`, metadata(q))
  files.set(`${dir}/query.rego`, rego(q))
  files.set(`${dir}/test/positive.json`, `${JSON.stringify(template(q.positive), null, 2)}\n`)
  files.set(`${dir}/test/negative.json`, `${JSON.stringify(template(negativeFor(q)), null, 2)}\n`)
}

const check = process.argv.includes('--check')

if (check) {
  let stale = 0
  const expected = new Set(files.keys())
  const actual = new Set()
  const walk = dir => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else actual.add(relative(outDir, full).split('\\').join('/'))
    }
  }
  walk(outDir)

  for (const [path, content] of files) {
    const full = join(outDir, path)
    if (!existsSync(full) || readFileSync(full, 'utf8') !== content) {
      console.error(`  stale  ${path}`)
      stale += 1
    }
  }
  for (const path of actual) {
    if (!expected.has(path)) {
      console.error(`  orphan ${path}`)
      stale += 1
    }
  }
  if (stale > 0) {
    console.error(
      `\nkics queries: ${stale} file(s) out of date. Run \`node tools/gen_kics_queries.js\`.`,
    )
    process.exit(1)
  }
  console.log(`kics queries: ${QUERIES.length} queries, all files current`)
} else {
  rmSync(outDir, { recursive: true, force: true })
  for (const [path, content] of files) {
    const full = join(outDir, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, { encoding: 'utf8' })
  }
  console.log(`kics queries: wrote ${files.size} files for ${QUERIES.length} queries`)
}

export { QUERIES }
