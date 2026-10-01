/**
 * SetlistZeroCostPack — the preventive layer of the $0 guarantee.
 *
 * Four layers protect the budget (PED §2). This is the first: it fails `cdk synth`, so
 * a resource that would cost money never reaches a template, let alone an account. The
 * others — no idle-billing resources by construction, runtime concurrency caps, and a
 * zero-spend budget wired to a kill switch — all act later and cost more to trigger.
 *
 * Applied as a CDK Aspect, so it sees every construct in the tree including the ones
 * L2 constructs add on your behalf. That matters: the expensive resource is usually
 * the one you did not write.
 *
 * Suppressions go through cdk-nag's normal mechanism and are governed by
 * `security/suppressions.yaml` — owner, reason, and an expiry no more than 90 days out.
 * A suppression accepts a cost for a while; it does not delete a rule.
 */

import { Stack } from 'aws-cdk-lib'
import type { CfnResource } from 'aws-cdk-lib'
import type { IConstruct } from 'constructs'
import { NagMessageLevel, NagPack, type NagPackProps, NagRuleCompliance } from 'cdk-nag'
import { type EnvName, ENV_NAMES, loadBudget, shareFor } from '../lib/config/budget.js'
import { renderedProps, SZC_RULES, type RuleContext } from './rules.js'

export interface SetlistZeroCostPackProps extends NagPackProps {
  /**
   * Which environment's budget shares to enforce.
   *
   * Omitted, the pack reads the `env` context the app was synthesized with. Failing
   * that it falls back to the account-wide allowance, which is a weaker ceiling but
   * still a real one — the alternative, abstaining, would be a gate that cannot fail.
   */
  readonly envName?: EnvName

  /**
   * Report violations as warnings rather than errors.
   *
   * For inspecting an existing template, never for a gate. Defaults to false, and the
   * default is the one that matters: a pack that warns is a pack that gets ignored.
   */
  readonly warnOnly?: boolean
}

export class SetlistZeroCostPack extends NagPack {
  private readonly level: NagMessageLevel
  private readonly envName: EnvName | undefined

  constructor(props?: SetlistZeroCostPackProps) {
    super(props)
    this.packName = 'SetlistZeroCost'
    this.level = props?.warnOnly === true ? NagMessageLevel.WARN : NagMessageLevel.ERROR
    this.envName = props?.envName
  }

  visit(node: IConstruct): void {
    if (!isCfnResource(node)) return

    // Built once per resource, not once per rule: rendering properties costs a
    // `resolve` over the whole resource, and there are twenty-odd rules.
    const ctx: RuleContext = {
      props: renderedProps(node),
      maxAlarms: this.maxAlarmsFor(node),
      // Lazy: only the alarm-budget rule needs this, and computing it walks the stack.
      get ordinal(): number {
        return ordinalOf(node)
      },
    }

    for (const rule of SZC_RULES) {
      this.applyRule({
        ruleSuffixOverride: rule.id,
        info: `${rule.title}.`,
        // The explanation carries the actual charge. A rule that only says "banned"
        // gets argued with; one that says "$0.045/hour with no free tier" does not.
        explanation:
          `${rule.why} ` +
          'See PED §12 and infra/free-tier/budget.yaml. If this is genuinely needed it ' +
          'is a human-needed issue with an ADR proposal — not a suppression.',
        level: this.level,
        node,
        rule: (target: CfnResource): NagRuleCompliance =>
          rule.check(target, ctx) ? NagRuleCompliance.NON_COMPLIANT : NagRuleCompliance.COMPLIANT,
      })
    }
  }

  /** This environment's alarm share, or the account-wide ceiling if the env is unknown. */
  private maxAlarmsFor(node: CfnResource): number {
    const env = this.envName ?? asEnvName(node.node.tryGetContext('env'))
    if (env !== undefined) return shareFor('cloudwatch_alarms', env)
    return loadBudget().limits['cloudwatch_alarms']?.total ?? 0
  }
}

/**
 * This resource's position among resources of the same type in its stack, ordered by
 * construct path.
 *
 * Sorting by path rather than by tree order makes the verdict independent of the order
 * constructs happened to be declared in, so adding an unrelated alarm cannot move the
 * violation onto a different one.
 */
function ordinalOf(node: CfnResource): number {
  const paths = Stack.of(node)
    .node.findAll()
    .filter(isCfnResource)
    .filter(peer => peer.cfnResourceType === node.cfnResourceType)
    .map(peer => peer.node.path)
    .sort()
  return paths.indexOf(node.node.path)
}

function isCfnResource(node: IConstruct): node is CfnResource {
  return 'cfnResourceType' in node && typeof (node as CfnResource).cfnResourceType === 'string'
}

function asEnvName(value: unknown): EnvName | undefined {
  return ENV_NAMES.find(env => env === value)
}
