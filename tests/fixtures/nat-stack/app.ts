#!/usr/bin/env node
/**
 * A CDK app that MUST fail to synthesize.
 *
 * `make nag` runs this and fails if it succeeds. The point is not to test the SZC-NAT
 * rule — `infra/nag/test/pack.test.ts` does that against the rule directly — but to
 * test the wiring: that an app built the way `infra/bin/setlist.ts` is built actually
 * runs the pack, and that a violation stops `cdk synth` rather than being written into
 * a template with a warning nobody reads.
 *
 * Which is a distinction with a history. A pack that is constructed but never attached,
 * attached to a stack instead of the app, or attached after `app.synth()` produces a
 * clean build every time. So does a correct one. This fixture is the only thing that
 * tells those apart.
 *
 * It uses `applyZeroCostPack` rather than its own `Aspects.of(...)` call deliberately:
 * a fixture that wires itself proves the pack works and nothing about whether the real
 * entrypoint runs it.
 *
 * A NAT gateway is the fixture because it is the most expensive thing on the never-use
 * list that can be declared in four lines — about $32/month for existing.
 */

import { App, Stack } from 'aws-cdk-lib'
import { CfnNatGateway } from 'aws-cdk-lib/aws-ec2'
import { REGION } from '../../../infra/lib/config/profile.js'
import { applyZeroCostPack } from '../../../infra/nag/apply.js'

const app = new App()
const stack = new Stack(app, 'setlist-natgate-fixture', { env: { region: REGION } })

new CfnNatGateway(stack, 'Nat', {
  subnetId: 'subnet-0000000000000000',
  allocationId: 'eipalloc-0000000000000000',
})

// `dev` so the alarm budget resolves; this fixture is about SZC-NAT.
applyZeroCostPack(app, 'zero', 'dev')

app.synth()
