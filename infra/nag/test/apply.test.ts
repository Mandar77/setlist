/**
 * When the pack runs, and — just as importantly — when it does not.
 *
 * `applyZeroCostPack` is the only place that decides whether the $0 gate is enforced,
 * which makes it the easiest thing in the repo to get quietly wrong: every mistake
 * here produces a clean build.
 *
 * The enterprise case needs a control. "The pack is skipped under enterprise" is
 * trivially true if the enterprise stacks happen to contain nothing the pack would
 * object to — so the last test proves they DO contain something, and therefore that
 * the skip is load-bearing rather than decorative.
 */

import { App, Aspects, Stack } from 'aws-cdk-lib'
import { Annotations as AssertAnnotations, Match } from 'aws-cdk-lib/assertions'
import { describe, expect, it } from 'vitest'
import { applyZeroCostPack, shouldApplyPack } from '../apply.js'
import { SetlistZeroCostPack } from '../SetlistZeroCostPack.js'
import { CfnNatGateway } from 'aws-cdk-lib/aws-ec2'
import { REGION } from '../../lib/config/profile.js'
import { PlatformStack } from '../../lib/stacks/platform-stack.js'

const appWith = (context: Record<string, unknown>): App => new App({ context })

const szcErrors = (stack: Stack): string[] =>
  AssertAnnotations.fromStack(stack)
    .findError('*', Match.stringLikeRegexp('SetlistZeroCost-SZC'))
    .map(e => String(e.entry.data))

describe('when the pack is enforced', () => {
  it('is on by default under profile=zero', () => {
    expect(shouldApplyPack(appWith({}), 'zero')).toBe(true)
  })

  it('is off by default under profile=enterprise', () => {
    // That profile exists to use API Gateway, a custom bus and Express workflows —
    // all SZC violations by design.
    expect(shouldApplyPack(appWith({}), 'enterprise')).toBe(false)
  })

  it('can be forced on under enterprise with -c nag=true', () => {
    expect(shouldApplyPack(appWith({ nag: 'true' }), 'enterprise')).toBe(true)
  })

  it('can be forced off under zero with -c nag=false', () => {
    // The only off switch, so disabling the gate is visible in the command that did it.
    expect(shouldApplyPack(appWith({ nag: 'false' }), 'zero')).toBe(false)
  })

  it('accepts real booleans as well as the CLI’s strings', () => {
    expect(shouldApplyPack(appWith({ nag: true }), 'enterprise')).toBe(true)
    expect(shouldApplyPack(appWith({ nag: false }), 'zero')).toBe(false)
  })

  it('refuses a value it does not understand', () => {
    // `-c nag=yes` silently meaning "off" is how a gate stops running without anyone
    // noticing. Fail instead.
    expect(() => shouldApplyPack(appWith({ nag: 'yes' }), 'zero')).toThrow(/nag must be/)
  })
})

describe('applying it attaches to the app, not to one stack', () => {
  it('reaches a stack created before the call', () => {
    const app = appWith({})
    const stack = new Stack(app, 'Early', { env: { region: REGION } })
    new CfnNatGateway(stack, 'Nat', { subnetId: 'subnet-1', allocationId: 'eipalloc-1' })

    expect(applyZeroCostPack(app, 'zero', 'dev')).toBe(true)
    expect(szcErrors(stack).some(m => m.includes('SZC-NAT'))).toBe(true)
  })

  it('reaches a stack created after the call', () => {
    // Aspects are evaluated at synth time, so order should not matter — but "should
    // not" is the reason to check.
    const app = appWith({})
    expect(applyZeroCostPack(app, 'zero', 'dev')).toBe(true)

    const stack = new Stack(app, 'Late', { env: { region: REGION } })
    new CfnNatGateway(stack, 'Nat', { subnetId: 'subnet-1', allocationId: 'eipalloc-1' })

    expect(szcErrors(stack).some(m => m.includes('SZC-NAT'))).toBe(true)
  })

  it('attaches nothing under enterprise', () => {
    const app = appWith({})
    const stack = new Stack(app, 'Ent', { env: { region: REGION } })
    new CfnNatGateway(stack, 'Nat', { subnetId: 'subnet-1', allocationId: 'eipalloc-1' })

    expect(applyZeroCostPack(app, 'enterprise', 'dev')).toBe(false)
    expect(szcErrors(stack)).toEqual([])
  })
})

describe('skipping enterprise is load-bearing', () => {
  it('the enterprise platform stack really would violate the pack', () => {
    // If this ever passes clean, the enterprise profile has stopped differing from
    // zero in any way the pack can see — and "we skip the pack there" would be a
    // statement about nothing.
    const app = appWith({ profile: 'enterprise', env: 'dev' })
    const stack = new PlatformStack(app, 'setlist-dev-platform', {
      profile: 'enterprise',
      envName: 'dev',
      env: { region: REGION },
    })
    Aspects.of(stack).add(new SetlistZeroCostPack({ envName: 'dev' }))

    expect(
      szcErrors(stack).length,
      'the enterprise stack no longer uses anything the pack bans',
    ).toBeGreaterThan(0)
  })
})
