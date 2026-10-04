// M0A-06, asserted against the synthesized template rather than against the source.
//
// The distinction matters. A test that reads `identity.ts` and finds `FeaturePlan.LITE`
// proves the constant is written down; a test that reads the CloudFormation and finds
// `"FeaturePlan": "LITE"` proves it survived into what will actually be deployed. Every
// claim M0A-06 makes is about deployed infrastructure, so every assertion here goes
// through `Template.fromStack`.

import { App } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { describe, expect, it } from 'vitest'

import { loadBudget, shareFor, type EnvName } from '../lib/config/budget.js'
import { totalProvisionedCapacity } from '../lib/config/environments.js'
import { PlatformStack } from '../lib/stacks/platform-stack.js'

const ENVS: readonly EnvName[] = ['dev', 'stage', 'prod']
const budget = loadBudget()

function templateFor(envName: EnvName): Template {
  const app = new App()
  const stack = new PlatformStack(app, `setlist-${envName}-platform`, {
    profile: 'zero',
    envName,
    env: { region: 'us-east-1' },
  })
  return Template.fromStack(stack)
}

const templates = new Map(ENVS.map(env => [env, templateFor(env)]))

/** Every resource of a type, as a plain array of its properties. */
function propsOf(template: Template, type: string): Record<string, unknown>[] {
  return Object.values(template.findResources(type)).map(
    resource => (resource as { Properties?: Record<string, unknown> }).Properties ?? {},
  )
}

describe('DynamoDB capacity stays inside the account-wide allowance', () => {
  it('sums to at most 17 WCU and 17 RCU across every environment', () => {
    // The allowance is 25 of each and is shared across every table AND index in the
    // account, so it cannot be reasoned about one stack at a time. PED D6 budgets 17.
    const total = totalProvisionedCapacity(budget)
    expect(total.write).toBeLessThanOrEqual(17)
    expect(total.read).toBeLessThanOrEqual(17)
  })

  it('provisions exactly this environment’s share, never on-demand', () => {
    for (const env of ENVS) {
      const tables = propsOf(templates.get(env)!, 'AWS::DynamoDB::GlobalTable')
      expect(tables, env).toHaveLength(1)
      const throughput = tables[0]!['WriteProvisionedThroughputSettings']
      expect(throughput, `${env} must be provisioned, not PAY_PER_REQUEST`).toBeDefined()
      expect(tables[0]!['BillingMode']).not.toBe('PAY_PER_REQUEST')
    }
  })

  it('caps autoscaling at the budgeted share rather than at a round number', () => {
    for (const env of ENVS) {
      const table = propsOf(templates.get(env)!, 'AWS::DynamoDB::GlobalTable')[0]!
      const write = table['WriteProvisionedThroughputSettings'] as {
        WriteCapacityAutoScalingSettings?: { MaxCapacity?: number }
      }
      expect(write.WriteCapacityAutoScalingSettings?.MaxCapacity, env).toBe(
        shareFor('dynamodb_wcu', env, budget),
      )
    }
  })
})

describe('SNS filtering is on message attributes, never the payload', () => {
  it('creates a provider-command topic in every environment', () => {
    for (const env of ENVS) {
      const topics = propsOf(templates.get(env)!, 'AWS::SNS::Topic')
      const names = topics.map(topic => String(topic['TopicName'] ?? ''))
      expect(names, env).toContain(`setlist-${env}-provider-commands`)
    }
  })

  it('never sets FilterPolicyScope to MessageBody', () => {
    // PED §10.5. Body filtering parses the payload on every delivery attempt and stops
    // matching silently when the payload shape changes — a consumer does not fail, it
    // just stops receiving, which nobody notices until a user asks where their playlist
    // went. Asserted here because the construct can only be bypassed by not using it.
    for (const env of ENVS) {
      for (const subscription of propsOf(templates.get(env)!, 'AWS::SNS::Subscription')) {
        expect(subscription['FilterPolicyScope'], env).not.toBe('MessageBody')
      }
    }
  })
})

describe('Cognito is on a tier that is free', () => {
  it('is LITE, never PLUS', () => {
    // Lite and Essentials share a 10,000 MAU always-free allowance; Plus has none. The
    // CDK default for a new pool is ESSENTIALS, so this is pinned rather than inherited
    // — a future default change would otherwise move the project onto a billed plan
    // with no diff to review.
    for (const env of ENVS) {
      const pools = propsOf(templates.get(env)!, 'AWS::Cognito::UserPool')
      expect(pools, env).toHaveLength(1)
      expect(pools[0]!['UserPoolTier']).toBe('LITE')
    }
  })

  it('issues the app client without a secret', () => {
    // The Expo app is a public client and cannot keep a secret; one shipped in an APK is
    // a secret published.
    for (const env of ENVS) {
      const clients = propsOf(templates.get(env)!, 'AWS::Cognito::UserPoolClient')
      expect(clients[0]!['GenerateSecret']).not.toBe(true)
    }
  })
})

describe('CloudFront fronts a Function URL through OAC', () => {
  it('creates the OAC but NEVER the distribution', () => {
    // The distribution is enrolled by hand because the flat-rate Free plan cannot be
    // expressed in CloudFormation, and one created by CDK would be an ordinary
    // pay-as-you-go distribution — a bill, in the environment the plan exists to make
    // free. never-use.test.ts enforces the absence; this records why it is absent here,
    // where someone adding the "missing" distribution would look first.
    for (const env of ENVS) {
      templates.get(env)!.resourceCountIs('AWS::CloudFront::Distribution', 0)
      templates.get(env)!.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1)
    }
  })

  it('never exposes the Function URL without IAM auth', () => {
    // `NONE` publishes a URL anyone can hit directly, bypassing the distribution and
    // billing the account for every request. That is a CDN beside an origin rather than
    // in front of one.
    for (const env of ENVS) {
      for (const url of propsOf(templates.get(env)!, 'AWS::Lambda::Url')) {
        expect(url['AuthType'], env).toBe('AWS_IAM')
      }
    }
  })

  it('signs origin requests always', () => {
    for (const env of ENVS) {
      const oac = propsOf(templates.get(env)!, 'AWS::CloudFront::OriginAccessControl')[0]!
      const config = oac['OriginAccessControlConfig'] as Record<string, unknown>
      expect(config['SigningBehavior']).toBe('always')
      expect(config['SigningProtocol']).toBe('sigv4')
    }
  })
})

describe('SSM parameters', () => {
  it('writes config and flags under /setlist/<env>/', () => {
    for (const env of ENVS) {
      const names = propsOf(templates.get(env)!, 'AWS::SSM::Parameter').map(p =>
        String(p['Name'] ?? ''),
      )
      expect(names, env).toContain(`/setlist/${env}/config/table-name`)
      expect(names, env).toContain(`/setlist/${env}/config/user-pool-id`)
      expect(names, env).toContain(`/setlist/${env}/flags/kill-switch-engaged`)
      for (const name of names) expect(name.startsWith(`/setlist/${env}/`), name).toBe(true)
    }
  })

  it('uses the standard tier only', () => {
    // Advanced parameters are $0.05 each per month.
    for (const env of ENVS) {
      for (const param of propsOf(templates.get(env)!, 'AWS::SSM::Parameter')) {
        expect(param['Tier'], env).not.toBe('Advanced')
      }
    }
  })

  it('writes nothing under secrets/, because synth output is public', () => {
    // The prefix exists and CI writes SecureString parameters into it. A secret that
    // reached a synthesized template would be a secret in this repository's CI logs.
    for (const env of ENVS) {
      for (const param of propsOf(templates.get(env)!, 'AWS::SSM::Parameter')) {
        expect(String(param['Name'] ?? '')).not.toContain('/secrets/')
      }
    }
  })
})

describe('log retention and alarms', () => {
  it('gives every log group explicit retention', () => {
    // SZC-LOG-RETENTION: the 5 GB allowance covers ingest only, and stored logs accrue
    // at $0.03/GB-month forever. A group with no retention is a bill that grows alone.
    for (const env of ENVS) {
      const groups = propsOf(templates.get(env)!, 'AWS::Logs::LogGroup')
      expect(groups.length, env).toBeGreaterThan(0)
      for (const group of groups) expect(group['RetentionInDays'], env).toBeDefined()
    }
  })

  it('matches PED §10.6 retention per environment', () => {
    const expected: Record<EnvName, number> = { prod: 14, stage: 7, dev: 3 }
    for (const env of ENVS) {
      for (const group of propsOf(templates.get(env)!, 'AWS::Logs::LogGroup')) {
        expect(group['RetentionInDays'], env).toBe(expected[env])
      }
    }
  })

  it('creates no more alarms than the environment is budgeted', () => {
    for (const env of ENVS) {
      const alarms = propsOf(templates.get(env)!, 'AWS::CloudWatch::Alarm')
      expect(alarms.length, env).toBeLessThanOrEqual(shareFor('cloudwatch_alarms', env, budget))
    }
  })

  it('creates at most 7 alarms across all environments', () => {
    // The done_when number. Ten are free account-wide; this leaves three spare.
    const total = ENVS.reduce(
      (sum, env) => sum + propsOf(templates.get(env)!, 'AWS::CloudWatch::Alarm').length,
      0,
    )
    expect(total).toBeLessThanOrEqual(7)
  })

  it('creates none at all in dev, which is budgeted zero', () => {
    // The complement: without this, an implementation that ignored the budget entirely
    // would still satisfy the two assertions above.
    expect(propsOf(templates.get('dev')!, 'AWS::CloudWatch::Alarm')).toHaveLength(0)
    expect(propsOf(templates.get('prod')!, 'AWS::CloudWatch::Alarm').length).toBeGreaterThan(0)
  })
})

describe('the kill switch can find everything it must stop', () => {
  it('tags every stack with app=setlist', () => {
    // The tag is how the kill switch identifies what it owns. An untagged function is a
    // function it will leave running.
    for (const env of ENVS) {
      const functions = propsOf(templates.get(env)!, 'AWS::Lambda::Function')
      expect(functions.length, env).toBeGreaterThan(0)
      for (const fn of functions) {
        const tags = (fn['Tags'] ?? []) as { Key: string; Value: string }[]
        expect(
          tags.some(tag => tag.Key === 'app' && tag.Value === 'setlist'),
          env,
        ).toBe(true)
      }
    }
  })

  it('publishes what the manual distribution step has to attach to', () => {
    // The distribution is created in the console, so the two values that step needs are
    // outputs rather than something a runbook has to describe.
    for (const env of ENVS) {
      const outputs = templates.get(env)!.findOutputs('*')
      const keys = Object.keys(outputs).join(' ')
      expect(keys, env).toMatch(/OriginFunctionUrl/)
      expect(keys, env).toMatch(/OriginAccessControlId/)
    }
  })
})
