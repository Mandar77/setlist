/**
 * The account bootstrap: the deny list, and the trust policy.
 *
 * Two things here are worth more than the rest put together.
 *
 * **Coverage of the never-use list.** IAM denies actions; half the never-use list is
 * about properties. A boundary that looks complete while covering two thirds of the
 * list is worse than an obviously partial one, so every entry in `budget.yaml` must be
 * accounted for in exactly one of two places, and the "IAM cannot express this" list
 * must name a real SZC rule that does.
 *
 * **The OIDC subject condition.** `StringLike` with `repo:owner/name:*` is assumable
 * from any ref in the repository, including a branch pushed by a fork's pull request.
 * It is the standard way this is got wrong and it hands deploy credentials to anyone
 * who can open a PR. The test below fails on any wildcard in a subject condition.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadBudget } from '../lib/config/budget.js'
import { SZC_RULE_IDS } from '../nag/rules.js'
import { DENIED_ACTIONS, NOT_EXPRESSIBLE_IN_IAM } from '../bootstrap/never-use-iam.js'
import { buildTemplate, DEPLOY_ENVIRONMENTS } from '../bootstrap/template.js'
import { render, TEMPLATE_PATH } from '../bootstrap/generate.js'

const template = buildTemplate() as {
  Metadata: Record<string, any>
  Parameters: Record<string, unknown>
  Conditions: Record<string, unknown>
  Resources: Record<string, { Type: string; Properties: Record<string, any> }>
  Outputs: Record<string, unknown>
}
const resources = template.Resources
const budget = loadBudget()

const byType = (type: string): [string, (typeof resources)[string]][] =>
  Object.entries(resources).filter(([, r]) => r.Type === type)

const boundaryStatements = (): any[] =>
  resources['ZeroCostBoundary']!.Properties['PolicyDocument'].Statement

describe('the deny list covers the never-use list', () => {
  it('accounts for every never_use entry', () => {
    const uncovered = budget.neverUse.filter(
      entry =>
        !DENIED_ACTIONS.some(rule => rule.enforces.test(entry)) &&
        !NOT_EXPRESSIBLE_IN_IAM.some(rule => rule.enforces.test(entry)),
    )
    expect(
      uncovered,
      `never_use entries with neither an IAM deny nor a recorded reason why not:\n  ${uncovered.join('\n  ')}`,
    ).toEqual([])
  })

  it('has no deny rule that enforces nothing', () => {
    // A rule matching no budget entry is either a typo or a leftover, and either way it
    // is a line of policy nobody can explain.
    const dead = DENIED_ACTIONS.filter(
      rule => !budget.neverUse.some(entry => rule.enforces.test(entry)),
    ).map(rule => rule.enforces.source)
    expect(dead, `deny rules matching no never_use entry: ${dead.join(', ')}`).toEqual([])
  })

  it('has no "not expressible" entry that enforces nothing', () => {
    const dead = NOT_EXPRESSIBLE_IN_IAM.filter(
      rule => !budget.neverUse.some(entry => rule.enforces.test(entry)),
    ).map(rule => rule.enforces.source)
    expect(dead).toEqual([])
  })

  it('names a real SZC rule for everything IAM cannot express', () => {
    // This is what stops the second list becoming a place to park an entry with no
    // enforcement anywhere at all.
    for (const entry of NOT_EXPRESSIBLE_IN_IAM) {
      expect(
        SZC_RULE_IDS,
        `${entry.enforces.source} claims to be covered by ${entry.coveredBy}, which is not a rule`,
      ).toContain(entry.coveredBy)
      expect(entry.why.length, `${entry.coveredBy} has no explanation`).toBeGreaterThan(40)
    }
  })

  it('denies the operations CLAUDE.md bans as billed-per-call', () => {
    const denied = DENIED_ACTIONS.flatMap(rule => rule.actions)
    for (const action of ['cloudwatch:GetMetricData', 'logs:StartQuery', 'ce:GetCostAndUsage']) {
      expect(denied, `${action} is billed per call and must be denied`).toContain(action)
    }
  })

  it('denies joining an AWS Organization', () => {
    // The single most expensive API call available here: it ends the free tier for the
    // life of the account, immediately and irreversibly (PED S1).
    const sids = boundaryStatements().map(s => s.Sid)
    expect(sids).toContain('DenyOrganizationMembership')
  })
})

describe('the permission boundary is a boundary, not a wish', () => {
  it('opens with an explicit allow', () => {
    // A boundary is an intersection. One made only of denies grants nothing at all,
    // and the first symptom is a deploy failing on its first API call.
    const first = boundaryStatements()[0]
    expect(first.Effect).toBe('Allow')
    expect(first.Action).toBe('*')
  })

  it('keeps conditional denies in their own statements', () => {
    // A Condition applies to the whole statement. Folding the VPC-only deny in with the
    // unconditional ones would make every one of them conditional, and the list would
    // stop working without looking any different.
    const unconditional = boundaryStatements().find((s: any) => s.Sid === 'DenyNeverUseServices')
    expect(unconditional.Condition).toBeUndefined()

    const conditionals = DENIED_ACTIONS.filter(r => r.condition !== undefined)
    for (const rule of conditionals) {
      const statement = boundaryStatements().find(
        (s: any) => s.Condition !== undefined && rule.actions.every(a => s.Action.includes(a)),
      )
      expect(statement, `${rule.enforces.source} lost its condition`).toBeDefined()
    }
  })

  it('cannot be escaped by creating an unbounded role', () => {
    // Without this, a deploy role creates a role with no boundary and uses it to do
    // everything the boundary forbids.
    const escape = boundaryStatements().find(
      (s: any) => s.Sid === 'DenyRoleCreationWithoutThisBoundary',
    )
    expect(escape).toBeDefined()
    expect(escape.Action).toContain('iam:CreateRole')
    expect(Object.keys(escape.Condition)).toContain('StringNotEquals')
  })

  it('cannot be edited away by the roles it binds', () => {
    const tamper = boundaryStatements().find((s: any) => s.Sid === 'DenyBoundaryTampering')
    expect(tamper.Action).toContain('iam:CreatePolicyVersion')
    expect(tamper.Action).toContain('iam:DeleteRolePermissionsBoundary')
  })

  it('is carried by every role in the template', () => {
    for (const [name, role] of byType('AWS::IAM::Role')) {
      expect(role.Properties['PermissionsBoundary'], `${name} has no boundary`).toBeDefined()
    }
  })
})

describe('the OIDC trust is scoped to one repository and one environment', () => {
  const roleTrusts = (): [string, any][] =>
    byType('AWS::IAM::Role')
      .map(([name, role]) => [name, role.Properties['AssumeRolePolicyDocument']] as [string, any])
      .filter(([, doc]) => JSON.stringify(doc).includes('token.actions.githubusercontent.com'))

  it('has a role per deploy environment plus diagnostics', () => {
    expect(roleTrusts()).toHaveLength(DEPLOY_ENVIRONMENTS.length + 1)
  })

  it('matches the subject with StringEquals, never a wildcard', () => {
    for (const [name, doc] of roleTrusts()) {
      const condition = doc.Statement[0].Condition
      expect(Object.keys(condition), `${name} must use StringEquals`).toEqual(['StringEquals'])

      const subject = condition.StringEquals['token.actions.githubusercontent.com:sub']
      const rendered = JSON.stringify(subject)
      expect(
        rendered,
        `${name} has a wildcard subject — any fork PR could assume it`,
      ).not.toContain('*')
      expect(rendered, `${name} is not scoped to a GitHub environment`).toContain('environment:')
    }
  })

  it('checks the audience as well as the subject', () => {
    for (const [name, doc] of roleTrusts()) {
      const aud = doc.Statement[0].Condition.StringEquals['token.actions.githubusercontent.com:aud']
      expect(aud, `${name} does not pin the audience`).toBe('sts.amazonaws.com')
    }
  })

  it('scopes each deploy role to its own environment', () => {
    for (const env of DEPLOY_ENVIRONMENTS) {
      const name = `DeployRole${env[0]!.toUpperCase()}${env.slice(1)}`
      const doc = resources[name]!.Properties['AssumeRolePolicyDocument']
      const subject = JSON.stringify(
        doc.Statement[0].Condition.StringEquals['token.actions.githubusercontent.com:sub'],
      )
      expect(subject).toContain(`environment:${env}`)
      // prod must not be assumable from the dev environment, which is what a shared
      // subject would allow.
      for (const other of DEPLOY_ENVIRONMENTS.filter(e => e !== env)) {
        expect(subject).not.toContain(`environment:${other}`)
      }
    }
  })

  it('keeps the diagnostics role read-only and off the billed APIs', () => {
    const role = resources['DiagnosticsRole']!.Properties
    expect(JSON.stringify(role['ManagedPolicyArns'])).toContain('ReadOnlyAccess')
    const deny = role['Policies'][0].PolicyDocument.Statement[0]
    expect(deny.Effect).toBe('Deny')
    // ReadOnlyAccess includes these and they are billed per call. A read-only role that
    // costs money every time it is used is not the harmless thing it looks like.
    expect(deny.Action).toContain('cloudwatch:GetMetricData')
  })
})

describe('the billing guardrails stay inside the free allowance', () => {
  it('creates exactly two budgets', () => {
    // The first two budgets are free; a third is billed. PED S11.
    expect(byType('AWS::Budgets::Budget')).toHaveLength(2)
  })

  it('creates no more than two budget actions', () => {
    expect(byType('AWS::Budgets::BudgetsAction').length).toBeLessThanOrEqual(2)
  })

  it('trips automatically on actual spend and only manually on a forecast', () => {
    // A forecast is a projection: an early-month spike can forecast a month that never
    // happens, and an automatic deny would lock out the very deploy that fixes it.
    expect(resources['ZeroSpendAction']!.Properties['ApprovalModel']).toBe('AUTOMATIC')
    expect(resources['ZeroSpendAction']!.Properties['NotificationType']).toBe('ACTUAL')
    expect(resources['ForecastAction']!.Properties['ApprovalModel']).toBe('MANUAL')
    expect(resources['ForecastAction']!.Properties['NotificationType']).toBe('FORECASTED')
  })

  it('attaches the spend-stop policy to every deploy role', () => {
    for (const action of ['ZeroSpendAction', 'ForecastAction']) {
      const roles = resources[action]!.Properties['Definition'].IamActionDefinition.Roles
      expect(roles).toEqual(DEPLOY_ENVIRONMENTS.map(env => `setlist-deploy-${env}`))
    }
  })

  it('leaves deletes and reads possible after the switch trips', () => {
    // Stopping the bleeding must not block the cleanup.
    const notAction = resources['SpendStopPolicy']!.Properties['PolicyDocument'].Statement[0]
      .NotAction as string[]
    expect(notAction).toContain('cloudformation:Delete*')
    expect(notAction).toContain('sts:GetCallerIdentity')
  })

  it('subscribes an email to the billing topic and a monitor to anomalies', () => {
    const topic = resources['BillingTopic']!.Properties
    expect(topic['Subscription'][0].Protocol).toBe('email')
    expect(byType('AWS::CE::AnomalyMonitor')).toHaveLength(1)
    expect(byType('AWS::CE::AnomalySubscription')).toHaveLength(1)
  })
})

describe('nothing identifying is committed', () => {
  const yaml = render()

  it('takes the account id, repository and email as parameters', () => {
    for (const name of ['GitHubOwner', 'GitHubRepo', 'AlertEmail']) {
      expect(template.Parameters[name], `${name} must be a parameter`).toBeDefined()
    }
  })

  it('contains no literal account id, ARN or email', () => {
    // ADR-005: this repository is public. The same rule tools/check_no_secrets.py
    // enforces, asserted here so the template cannot regress between scans.
    expect(yaml, 'a twelve-digit account id reached the template').not.toMatch(
      /arn:aws[^\s"']*:\d{12}/,
    )
    expect(yaml, 'an email address reached the template').not.toMatch(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
    )
  })

  it('documents every parameter', () => {
    const labels = template.Metadata['AWS::CloudFormation::Interface'].ParameterLabels
    for (const name of Object.keys(template.Parameters)) {
      expect(labels[name], `${name} has no label in the console`).toBeDefined()
      expect((template.Parameters[name] as any).Description.length).toBeGreaterThan(20)
    }
  })

  it('is committed in the state the generator produces', () => {
    // The template is the one file a human uploads by hand, so the version reviewed in
    // the diff has to be the version built from the deny list these tests assert on.
    expect(readFileSync(TEMPLATE_PATH, 'utf8')).toBe(yaml)
  })
})

describe('the roles the template creates are the roles Session 1 wires up', () => {
  // `session1-finish.sh` derives four ARNs from one account id rather than asking a
  // human to retype them, which is right — four prompts is four chances to paste the
  // wrong ARN into the wrong environment — but it means the role names live in two
  // files. A rename here would leave the script writing ARNs for roles that do not
  // exist, and the failure would surface as an opaque STS error in CI.
  const script = readFileSync(
    new URL('../../scripts/hitl/session1-finish.sh', import.meta.url),
    'utf8',
  )

  it('names every deploy role the script will construct', () => {
    for (const env of DEPLOY_ENVIRONMENTS) {
      const roleName = resources[`DeployRole${env[0]!.toUpperCase()}${env.slice(1)}`]!.Properties[
        'RoleName'
      ] as string
      expect(roleName).toBe(`setlist-deploy-${env}`)
    }
    // The script builds them from a prefix plus the environment name.
    expect(script).toContain('DEPLOY_ROLE_PREFIX="setlist-deploy-"')
    expect(script).toContain('DEPLOY_ENVIRONMENTS=(dev stage prod)')
  })

  it('names the diagnostics role the script will construct', () => {
    expect(resources['DiagnosticsRole']!.Properties['RoleName']).toBe('setlist-diagnostics')
    expect(script).toContain('DIAGNOSTICS_ROLE="setlist-diagnostics"')
  })

  it('uses a role name that cannot contain a region or account', () => {
    // The names are fixed strings, not `Fn::Sub`. If they were substituted, the script
    // could not derive them from the account id alone.
    for (const [name, role] of byType('AWS::IAM::Role')) {
      expect(typeof role.Properties['RoleName'], `${name} has a computed RoleName`).toBe('string')
    }
  })
})

describe('the template is well formed', () => {
  it('guards the OIDC provider behind a condition', () => {
    // An account holds one provider per URL; a second upload fails with
    // EntityAlreadyExists and leaves the stack stuck in ROLLBACK_FAILED.
    expect(resources['GitHubOidcProvider']!['Condition' as 'Type']).toBe('CreateOidcProvider')
    expect(template.Conditions['CreateOidcProvider']).toBeDefined()
  })

  it('outputs every role ARN the workflows need', () => {
    for (const output of [
      'DeployRoleArnDev',
      'DeployRoleArnStage',
      'DeployRoleArnProd',
      'DiagnosticsRoleArn',
      'BoundaryArn',
    ]) {
      expect(template.Outputs[output], `${output} is not exported`).toBeDefined()
    }
  })
})
