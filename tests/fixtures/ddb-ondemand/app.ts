#!/usr/bin/env node
/**
 * A CDK app that MUST fail to synthesize, on SZC-DDB-ONDEMAND.
 *
 * The second canary, and it tests something the NAT one cannot. SZC-NAT bans a resource
 * TYPE: the rule fires on `AWS::EC2::NatGateway` and nothing else has to be understood.
 * This one turns on a PROPERTY of a resource the project uses constantly — the same
 * table, with `BillingMode: PAY_PER_REQUEST` instead of provisioned capacity.
 *
 * That distinction is where a cost gate actually fails in practice. A rule reading a
 * typed L1 accessor rather than the rendered template misses any property set through
 * an escape hatch, and two of these rules shipped that way before their fixtures caught
 * it. A type ban would have passed either version.
 *
 * On-demand costs money from the first request; the free allowance is 25 WCU/25 RCU of
 * PROVISIONED capacity, shared account-wide across every table and index (PED D6).
 */

import { App, Stack } from 'aws-cdk-lib'
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb'
import { REGION } from '../../../infra/lib/config/profile.js'
import { applyZeroCostPack } from '../../../infra/nag/apply.js'

const app = new App()
const stack = new Stack(app, 'setlist-ondemand-fixture', { env: { region: REGION } })

new Table(stack, 'Table', {
  partitionKey: { name: 'pk', type: AttributeType.STRING },
  // The one line under test.
  billingMode: BillingMode.PAY_PER_REQUEST,
})

applyZeroCostPack(app, 'zero', 'dev')

app.synth()
