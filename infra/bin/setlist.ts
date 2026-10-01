#!/usr/bin/env node
/**
 * CDK app entrypoint.
 *
 *   cdk synth --all -c env=dev                        # profile=zero, the default
 *   cdk synth --all -c env=prod -c profile=enterprise # only when the human asked
 *
 * Synthesis is offline by design. No context lookups, so no AWS call and no
 * credentials — which is what lets `make synth` sit inside a gate that must run on a
 * machine ADR-005 keeps credential-free. The account, when there is one, comes from
 * the CI session's environment.
 */

import { App } from 'aws-cdk-lib'
import { REGION, resolve, stackName } from '../lib/config/profile.js'
import { PlatformStack } from '../lib/stacks/platform-stack.js'

const app = new App()
const { profile, env, account } = resolve(app)

// Omit `account` entirely when there is none, rather than passing undefined:
// `exactOptionalPropertyTypes` draws the distinction, and so does CDK. An absent
// account means environment-agnostic, which is what a local credential-free synth
// needs; CI supplies CDK_DEFAULT_ACCOUNT and the stack pins to it.
const cdkEnv = account === undefined ? { region: REGION } : { account, region: REGION }

new PlatformStack(app, stackName(env, 'platform'), {
  profile,
  envName: env,
  env: cdkEnv,
  description: `Setlist platform (${env}, profile=${profile})`,
  tags: { app: 'setlist', env, profile },
})

app.synth()
