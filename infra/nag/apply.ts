/**
 * Where the zero-cost pack gets attached to an app.
 *
 * One helper rather than a line in the entrypoint, because the nat-stack gate fixture
 * under `tests/fixtures/` has to attach it exactly the way the real app does. If the
 * fixture wired its own Aspect, it would prove the pack works and prove nothing about
 * whether `cdk synth` is actually running it.
 *
 * ## When it runs
 *
 * Under `profile=zero` the pack is ON by default. Opt-in enforcement is the shape of
 * every guardrail that quietly stops running: the day someone synthesizes without
 * `-c nag=true` is the day the resource gets through, and nothing about that synth
 * looks different.
 *
 * Under `profile=enterprise` it is OFF by default, because that profile deliberately
 * uses API Gateway, a custom event bus and Express workflows — every one of which is
 * an SZC violation. Enforcing there would fail `make synth-matrix` on resources the
 * profile exists to create.
 *
 * `-c nag=true` forces it on anywhere; `-c nag=false` forces it off. The second is for
 * inspecting a template, and it is the only switch, so turning the gate off is visible
 * in the command that did it.
 */

import { Aspects, type App } from 'aws-cdk-lib'
import type { EnvName } from '../lib/config/budget.js'
import type { Profile } from '../lib/config/profile.js'
import { SetlistZeroCostPack } from './SetlistZeroCostPack.js'

/** Resolve the `nag` context flag. Absent means "use the profile default". */
function nagContext(app: App): boolean | undefined {
  const raw: unknown = app.node.tryGetContext('nag')
  if (raw === undefined || raw === null || raw === '') return undefined
  // The CDK CLI passes `-c nag=true` as the string "true", never a boolean.
  if (raw === true || raw === 'true') return true
  if (raw === false || raw === 'false') return false
  throw new Error(`-c nag must be true or false, got '${String(raw)}'`)
}

export function shouldApplyPack(app: App, profile: Profile): boolean {
  return nagContext(app) ?? profile === 'zero'
}

/**
 * Attach the zero-cost pack, if this profile and context call for it.
 *
 * Returns whether it was attached, so a caller can say so rather than leaving the
 * question of whether the gate ran to be inferred from an empty findings list.
 */
export function applyZeroCostPack(app: App, profile: Profile, envName: EnvName): boolean {
  if (!shouldApplyPack(app, profile)) return false
  Aspects.of(app).add(new SetlistZeroCostPack({ envName }))
  return true
}
