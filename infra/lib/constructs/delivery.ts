/**
 * The origin CloudFront will sit in front of, and the OAC that lets only CloudFront reach
 * it — but **not** the distribution itself.
 *
 * ## Why the distribution is not synthesized
 *
 * `AWS::CloudFront::Distribution` is on the never-use list for `profile=zero`, and the
 * reason is specific rather than general: prod runs on the **flat-rate Free plan**, which
 * has to be enrolled in the console because CloudFormation cannot express it. A
 * distribution created by CDK would be an ordinary pay-as-you-go one — which is a bill,
 * in the environment the plan exists to make free.
 *
 * So this construct builds everything that *can* be expressed as code, and the
 * distribution is a HITL step that attaches to it. `infra/test/never-use.test.ts` enforces
 * the absence, and it caught exactly this mistake when the first version of this file
 * created one.
 *
 * ## Why not API Gateway
 *
 * Also on the never-use list (SZC-APIGW): credits-only for accounts opened after
 * 2025-07-15. A Function URL is free, and CloudFront in front of it buys the caching, the
 * certificate and the request allowance that would otherwise be API Gateway's job.
 *
 * ## Why OAC rather than a public Function URL
 *
 * `FunctionUrlAuthType.AWS_IAM` plus a `FunctionUrlOriginAccessControl` means the only
 * caller the function accepts is the distribution, signed. The alternative — `NONE` —
 * publishes a URL anyone can hit directly, bypassing the cache and billing the account
 * for every request. That is a CDN beside an origin rather than in front of one.
 *
 * ## Scaffold, not the BFF
 *
 * M0A-06 owns this wiring; M1-03 owns what answers. The placeholder handler exists so the
 * origin is real and the arrangement can be asserted today — a scaffold that does not
 * synthesize proves nothing.
 */

import { CfnOutput, Duration, type RemovalPolicy } from 'aws-cdk-lib'
import { FunctionUrlOriginAccessControl, Signing } from 'aws-cdk-lib/aws-cloudfront'
import {
  Code,
  Function as LambdaFunction,
  FunctionUrlAuthType,
  Runtime,
  type FunctionUrl,
} from 'aws-cdk-lib/aws-lambda'
import { LogGroup, type RetentionDays } from 'aws-cdk-lib/aws-logs'
import { Construct } from 'constructs'

import type { EnvName } from '../config/budget.js'

export interface DeliveryProps {
  readonly env: EnvName
  readonly logRetention: RetentionDays
  readonly removalPolicy: RemovalPolicy
}

/** The placeholder origin's body, until M1-03 replaces the handler. */
const PLACEHOLDER = [
  'exports.handler = async () => ({',
  '  statusCode: 503,',
  "  headers: { 'content-type': 'application/json' },",
  '  body: JSON.stringify({ error: "bff_not_deployed" }),',
  '})',
].join('\n')

export class Delivery extends Construct {
  readonly origin: LambdaFunction
  readonly functionUrl: FunctionUrl
  readonly originAccessControl: FunctionUrlOriginAccessControl

  constructor(scope: Construct, id: string, props: DeliveryProps) {
    super(scope, id)

    // Explicit log group rather than the function's implicit one. An implicit group has
    // no retention and never expires, which is SZC-LOG-RETENTION — the 5 GB allowance
    // covers ingest only, and stored logs accrue at $0.03/GB-month forever.
    const logGroup = new LogGroup(this, 'OriginLogs', {
      logGroupName: `/aws/lambda/setlist-${props.env}-bff`,
      retention: props.logRetention,
      removalPolicy: props.removalPolicy,
    })

    this.origin = new LambdaFunction(this, 'Origin', {
      functionName: `setlist-${props.env}-bff`,
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: Code.fromInline(PLACEHOLDER),
      memorySize: 256,
      timeout: Duration.seconds(10),
      logGroup,
      description: 'BFF origin. Placeholder until M1-03; the OAC wiring is M0A-06.',
    })

    this.functionUrl = this.origin.addFunctionUrl({
      // Never NONE. See the header.
      authType: FunctionUrlAuthType.AWS_IAM,
    })

    this.originAccessControl = new FunctionUrlOriginAccessControl(this, 'Oac', {
      originAccessControlName: `setlist-${props.env}-bff`,
      signing: Signing.SIGV4_ALWAYS,
    })

    // What the HITL step needs in order to attach a console-created distribution to this
    // origin. Outputs rather than a runbook paragraph, because a runbook that names a
    // resource goes stale and an output cannot.
    new CfnOutput(this, 'OriginFunctionUrl', {
      value: this.functionUrl.url,
      description: 'Origin domain for the manually enrolled CloudFront distribution.',
    })
    new CfnOutput(this, 'OriginAccessControlId', {
      value: this.originAccessControl.originAccessControlId,
      description: 'Attach this OAC to the distribution so the Function URL accepts it.',
    })
  }
}
