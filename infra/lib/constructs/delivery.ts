/**
 * CloudFront in front of a Lambda Function URL, with Origin Access Control.
 *
 * ## Why not API Gateway
 *
 * API Gateway is on the never-use list (SZC-APIGW): accounts opened after 2025-07-15 get
 * credits rather than a perpetual free tier for it. A Function URL is free, and putting
 * CloudFront in front of it buys the caching, the TLS certificate and the request
 * allowance that would otherwise be API Gateway's job.
 *
 * ## Why OAC rather than a public Function URL
 *
 * `FunctionUrlAuthType.AWS_IAM` plus a `FunctionUrlOriginAccessControl` means the only
 * caller the function accepts is this distribution, signed. The alternative — `NONE` —
 * publishes a URL that anybody can hit directly, bypassing the cache, the WAF-equivalent
 * controls and any rate limiting, and billing the account for every request. That is the
 * difference between a CDN in front of an origin and a CDN beside one.
 *
 * ## Scaffold, not the BFF
 *
 * M0A-06 owns the distribution and the OAC wiring; M1-03 owns what answers. The
 * placeholder handler here exists so the distribution has a real origin to point at and
 * so the whole arrangement synthesizes and can be asserted today — a scaffold that does
 * not synthesize proves nothing. Replacing the handler is M1-03's job and changes nothing
 * about the plumbing.
 */

import { Duration, RemovalPolicy } from 'aws-cdk-lib'
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  FunctionUrlOriginAccessControl,
  OriginRequestPolicy,
  PriceClass,
  Signing,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront'
import { FunctionUrlOrigin } from 'aws-cdk-lib/aws-cloudfront-origins'
import { Code, Function as LambdaFunction, FunctionUrlAuthType, Runtime } from 'aws-cdk-lib/aws-lambda'
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs'
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
  readonly distribution: Distribution
  readonly origin: LambdaFunction

  constructor(scope: Construct, id: string, props: DeliveryProps) {
    super(scope, id)

    // Explicit log group rather than the function's implicit one. An implicitly created
    // group has no retention and never expires, which is SZC-LOG-RETENTION — the 5 GB
    // allowance covers ingest only, and stored logs accrue at $0.03/GB-month forever.
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
      description: 'BFF origin. Placeholder until M1-03; the distribution wiring is M0A-06.',
    })

    const functionUrl = this.origin.addFunctionUrl({
      // Never NONE. See the header: NONE publishes a URL that bypasses the distribution.
      authType: FunctionUrlAuthType.AWS_IAM,
    })

    this.distribution = new Distribution(this, 'Distribution', {
      comment: `setlist-${props.env}`,
      // 100 is the cheapest class and covers North America and Europe. The flat-rate
      // Free plan's inclusion is what binds here either way (budget.yaml).
      priceClass: PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: FunctionUrlOrigin.withOriginAccessControl(functionUrl, {
          originAccessControl: new FunctionUrlOriginAccessControl(this, 'Oac', {
            signing: Signing.SIGV4_ALWAYS,
          }),
        }),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        // The API is per-user and authenticated; caching a response would serve one
        // user's playlist to another. Forward what the origin needs to authorize.
        cachePolicy: CachePolicy.CACHING_DISABLED,
        originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      },
      // No access logging bucket: S3 storage is credits-only on this account type and a
      // log bucket is a charge that grows on its own (SZC-S3-LIFECYCLE exists for
      // exactly that). CloudFront's free metrics cover what is needed.
    })
  }
}
