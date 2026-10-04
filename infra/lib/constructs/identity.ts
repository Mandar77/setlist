/**
 * The Cognito user pool, on the tier that is actually free.
 *
 * Cognito has three feature plans. **Lite** and **Essentials** share a 10,000 MAU
 * always-free allowance; **Plus** has no free tier at all, and neither does
 * machine-to-machine auth. PED §157 picks Lite, and `budget.yaml` budgets 6,000 of the
 * 10,000 MAU to prod.
 *
 * The tier is therefore a cost guardrail rather than a feature preference, which is why
 * it is pinned here and asserted in `platform.test.ts` rather than left to the CDK
 * default — the default for a newly created pool is Essentials, and a future CDK release
 * changing that default would move this project onto a billed plan without a diff.
 */

import { type RemovalPolicy } from 'aws-cdk-lib'
import {
  AccountRecovery,
  FeaturePlan,
  Mfa,
  UserPool,
  UserPoolClient,
  type UserPoolClientOptions,
} from 'aws-cdk-lib/aws-cognito'
import { Construct } from 'constructs'

import type { EnvName } from '../config/budget.js'

export interface IdentityProps {
  readonly env: EnvName
  readonly removalPolicy: RemovalPolicy
}

export class Identity extends Construct {
  readonly userPool: UserPool
  readonly appClient: UserPoolClient

  constructor(scope: Construct, id: string, props: IdentityProps) {
    super(scope, id)

    this.userPool = new UserPool(this, 'UserPool', {
      userPoolName: `setlist-${props.env}`,
      // The whole point of this construct. Never PLUS.
      featurePlan: FeaturePlan.LITE,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: false } },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      // SMS MFA bills per message through SNS and needs a spend limit nobody is
      // watching. Off, explicitly, so turning it on is a deliberate edit.
      mfa: Mfa.OFF,
      passwordPolicy: { minLength: 12, requireDigits: true, requireLowercase: true },
      removalPolicy: props.removalPolicy,
    })

    this.appClient = new UserPoolClient(this, 'AppClient', {
      userPool: this.userPool,
      userPoolClientName: `setlist-${props.env}-app`,
      // No client secret: the Expo app is a public client and cannot keep one. PKCE is
      // what protects the flow, and a secret shipped in an APK is a secret published.
      generateSecret: false,
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
    } satisfies UserPoolClientOptions & { userPool: UserPool })
  }
}
