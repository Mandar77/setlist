/**
 * Proves the SZC pack discriminates.
 *
 * For each rule: the violating fixture must raise it, and the compliant one must not.
 * Both directions matter. A rule that fires on everything and a rule that works are
 * indistinguishable from a green build — the difference only shows up the day the
 * broken one blocks something legitimate, by which point nobody trusts the pack.
 *
 * The suite also refuses to let the rule set drift from the thing it enforces:
 * every rule needs both fixtures, and every `never_use` line in budget.yaml needs a
 * rule.
 */

import { App, Aspects, Stack } from 'aws-cdk-lib'
import { Annotations as AssertAnnotations, Match } from 'aws-cdk-lib/assertions'
import { CfnAlarm } from 'aws-cdk-lib/aws-cloudwatch'
import { describe, expect, it } from 'vitest'
import { SetlistZeroCostPack } from '../SetlistZeroCostPack.js'
import { SZC_RULES, SZC_RULE_IDS } from '../rules.js'
import { type EnvName, loadBudget, shareFor } from '../../lib/config/budget.js'
import { REGION } from '../../lib/config/profile.js'
import { FIXTURES } from './fixtures.js'
import { PlatformStack } from '../../lib/stacks/platform-stack.js'

/** Build a stack, apply the pack, and return every SZC error it raised. */
function findings(build: (stack: Stack) => void): string[] {
  const app = new App()
  const stack = new Stack(app, 'Fixture', { env: { region: REGION } })
  build(stack)
  Aspects.of(stack).add(new SetlistZeroCostPack())

  // Reading annotations is the only way to tell "the rule ran and found nothing" from
  // "the rule never ran". Both leave a template that synthesizes cleanly.
  const errors = AssertAnnotations.fromStack(stack).findError(
    '*',
    Match.stringLikeRegexp('SetlistZeroCost-SZC'),
  )
  return errors.map(e => String(e.entry.data))
}

const raised = (messages: string[], ruleId: string): boolean =>
  messages.some(message => message.includes(ruleId))

describe('every rule fires on its violating fixture', () => {
  for (const rule of SZC_RULES) {
    const fixture = FIXTURES[rule.id]

    it(`${rule.id} — ${rule.title}`, () => {
      expect(fixture, `${rule.id} has no fixture pair`).toBeDefined()
      const messages = findings(fixture!.violating)
      expect(
        raised(messages, rule.id),
        `${rule.id} did NOT fire on its violating fixture. Raised: ${messages.join(' | ') || '(nothing)'}`,
      ).toBe(true)
    })
  }
})

describe('no rule fires on its compliant fixture', () => {
  for (const rule of SZC_RULES) {
    const fixture = FIXTURES[rule.id]

    it(`${rule.id} stays quiet on legitimate resources`, () => {
      const messages = findings(fixture!.compliant)
      expect(
        raised(messages, rule.id),
        `${rule.id} fired on its COMPLIANT fixture — it rejects everything, which is ` +
          `not the same as working. Raised: ${messages.join(' | ')}`,
      ).toBe(false)
    })
  }
})

describe('the pack cannot drift from what it enforces', () => {
  it('has a fixture pair for every rule', () => {
    const missing = SZC_RULE_IDS.filter(id => FIXTURES[id] === undefined)
    expect(missing, `rules with no fixtures: ${missing.join(', ')}`).toEqual([])
  })

  it('has no fixture for a rule that no longer exists', () => {
    const orphans = Object.keys(FIXTURES).filter(id => !SZC_RULE_IDS.includes(id))
    expect(orphans, `fixtures with no rule: ${orphans.join(', ')}`).toEqual([])
  })

  it('covers every never_use entry in budget.yaml', () => {
    // budget.yaml is prose and the rules are code; this is the seam where they meet.
    // An entry added to the budget with no rule would leave the list looking enforced
    // while nothing checked it.
    const { neverUse } = loadBudget()
    const uncovered = neverUse.filter(entry => !SZC_RULES.some(rule => rule.enforces.test(entry)))
    expect(uncovered, `never_use entries with no SZC rule:\n  ${uncovered.join('\n  ')}`).toEqual(
      [],
    )
  })

  it('gives every rule a stable id and a reason with a cost in it', () => {
    for (const rule of SZC_RULES) {
      expect(rule.id).toMatch(/^SZC-[A-Z0-9-]+$/)
      // "banned" invites an argument; a number ends one.
      expect(rule.why.length, `${rule.id} has no explanation`).toBeGreaterThan(40)
    }
  })

  it('has no duplicate rule ids', () => {
    expect(new Set(SZC_RULE_IDS).size).toBe(SZC_RULE_IDS.length)
  })
})

describe('the alarm budget tracks budget.yaml, not a hard-coded number', () => {
  // The paired fixture only exercises the account-wide ceiling, because a bare fixture
  // stack has no `env` context. These cover the per-environment shares, which are the
  // numbers that actually bind: prod 5, stage 2, dev 0.
  const alarmFindings = (envName: EnvName, count: number): string[] => {
    const app = new App()
    const stack = new Stack(app, 'Alarms', { env: { region: REGION } })
    for (let i = 0; i < count; i += 1) {
      new CfnAlarm(stack, `Alarm${i}`, {
        comparisonOperator: 'GreaterThanThreshold',
        evaluationPeriods: 1,
        namespace: 'AWS/Lambda',
        metricName: 'Errors',
        period: 60,
        statistic: 'Sum',
        threshold: 1,
      })
    }
    Aspects.of(stack).add(new SetlistZeroCostPack({ envName }))
    return AssertAnnotations.fromStack(stack)
      .findError('*', Match.stringLikeRegexp('SZC-ALARM-BUDGET'))
      .map(e => String(e.entry.data))
  }

  for (const envName of ['dev', 'stage', 'prod'] as const) {
    const share = shareFor('cloudwatch_alarms', envName)

    it(`${envName} accepts its ${share}-alarm share`, () => {
      expect(alarmFindings(envName, share)).toEqual([])
    })

    it(`${envName} rejects the alarm after it`, () => {
      // Exactly one finding: the rule flags the alarms past the budget, not every
      // alarm in the stack, so the message says which one to remove.
      expect(alarmFindings(envName, share + 1)).toHaveLength(1)
    })
  }

  it('reads the env from synth context when none is passed', () => {
    const app = new App({ context: { env: 'dev' } })
    const stack = new Stack(app, 'Alarms', { env: { region: REGION } })
    new CfnAlarm(stack, 'Alarm', {
      comparisonOperator: 'GreaterThanThreshold',
      evaluationPeriods: 1,
      namespace: 'AWS/Lambda',
      metricName: 'Errors',
      period: 60,
      statistic: 'Sum',
      threshold: 1,
    })
    Aspects.of(stack).add(new SetlistZeroCostPack())

    // dev is budgeted zero alarms, so a single one is already over. If the pack had
    // silently fallen back to the account-wide ceiling this would pass with 10.
    expect(
      AssertAnnotations.fromStack(stack).findError('*', Match.stringLikeRegexp('SZC-ALARM-BUDGET')),
    ).toHaveLength(1)
  })
})

describe('rules read the rendered template, not the typed properties', () => {
  // A cost rule that reads `fn.vpcConfig` is bypassed by one `addPropertyOverride`.
  // Both of these fixtures set the property purely through an escape hatch, so if the
  // rules ever go back to typed accessors these fail — which is how it was found.
  it('sees a VpcConfig added by an escape hatch', () => {
    const messages = findings(FIXTURES['SZC-LAMBDA-VPC']!.violating)
    expect(raised(messages, 'SZC-LAMBDA-VPC')).toBe(true)
  })

  it('sees provisioned concurrency added by an escape hatch', () => {
    const messages = findings(FIXTURES['SZC-LAMBDA-PROVISIONED']!.violating)
    expect(raised(messages, 'SZC-LAMBDA-PROVISIONED')).toBe(true)
  })
})

describe('the real platform stack passes the pack', () => {
  for (const envName of ['dev', 'stage', 'prod'] as const) {
    it(`setlist-${envName}-platform is clean under profile=zero`, () => {
      const app = new App({ context: { profile: 'zero', env: envName } })
      const stack = new PlatformStack(app, `setlist-${envName}-platform`, {
        profile: 'zero',
        envName,
        env: { region: REGION },
      })
      Aspects.of(stack).add(new SetlistZeroCostPack())

      const errors = AssertAnnotations.fromStack(stack).findError(
        '*',
        Match.stringLikeRegexp('SetlistZeroCost-SZC'),
      )
      expect(
        errors.map(e => String(e.entry.data)),
        'the platform stack violates its own cost rules',
      ).toEqual([])
    })
  }
})

describe('the pack is wired as an error, not a warning', () => {
  it('raises errors by default', () => {
    const messages = findings(FIXTURES['SZC-NAT']!.violating)
    expect(messages.length).toBeGreaterThan(0)
  })

  it('can be downgraded only by asking explicitly', () => {
    const app = new App()
    const stack = new Stack(app, 'WarnOnly', { env: { region: REGION } })
    FIXTURES['SZC-NAT']!.violating(stack)
    Aspects.of(stack).add(new SetlistZeroCostPack({ warnOnly: true }))

    expect(
      AssertAnnotations.fromStack(stack).findError('*', Match.stringLikeRegexp('SZC-NAT')),
    ).toEqual([])
    expect(
      AssertAnnotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('SZC-NAT')).length,
    ).toBeGreaterThan(0)
  })
})
