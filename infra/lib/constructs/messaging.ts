/**
 * The provider-command topic, and the filtering rule that makes SNS affordable.
 *
 * ## Message attributes, never the payload
 *
 * SNS can filter a subscription two ways. `FilterPolicyScope: MessageAttributes` matches
 * against the attributes a publisher sets alongside the message; `MessageBody` matches
 * against the message itself. The second is the one that looks convenient — no attribute
 * to remember to set — and it is the one PED §10.5 bans.
 *
 * Two reasons, and the second is the one that bites. Body filtering requires the payload
 * to be JSON and parses it on every delivery attempt, which turns a routing decision into
 * a function of data this project deliberately keeps out of events (PED D11: identifiers
 * only). And a body filter silently stops matching when the payload shape changes, so a
 * consumer does not fail — it simply stops receiving, which is the failure mode nobody
 * notices until a user asks where their playlist went.
 *
 * `subscribe` below only accepts attribute filters, and `platform.test.ts` asserts no
 * synthesized subscription carries `FilterPolicyScope: MessageBody` — the construct makes
 * the right thing easy and the template check makes the wrong thing impossible.
 */

import { Topic, type SubscriptionFilter } from 'aws-cdk-lib/aws-sns'
import { LambdaSubscription } from 'aws-cdk-lib/aws-sns-subscriptions'
import type { IFunction } from 'aws-cdk-lib/aws-lambda'
import { Construct } from 'constructs'

import type { EnvName } from '../config/budget.js'

export interface ProviderCommandsProps {
  readonly env: EnvName
}

/**
 * Commands addressed to a specific provider adapter.
 *
 * Separate from the domain bus on purpose. The domain topic carries facts that happened
 * and anyone may listen to; this carries instructions for one adapter, and the attribute
 * that says which adapter is exactly what a subscription filters on.
 */
export class ProviderCommands extends Construct {
  readonly topic: Topic

  constructor(scope: Construct, id: string, props: ProviderCommandsProps) {
    super(scope, id)

    this.topic = new Topic(this, 'Topic', {
      topicName: `setlist-${props.env}-provider-commands`,
      displayName: `Setlist ${props.env} provider commands`,
      // No `masterKey`: SNS has no free managed encryption, so encrypting at rest means
      // a customer-managed KMS key ($1/month, SZC-KMS-CMK) plus a KMS request per
      // publish. The payload is identifiers only. See the domain bus for the same call.
    })
  }

  /**
   * Subscribe a function, filtering on message attributes.
   *
   * The signature is the enforcement: there is no parameter here that could become a
   * body filter, so reaching for one means editing this file and explaining why.
   */
  subscribe(
    id: string,
    handler: IFunction,
    filterPolicy: Record<string, SubscriptionFilter>,
  ): void {
    this.topic.addSubscription(new LambdaSubscription(handler, { filterPolicy }))
    // `id` is accepted so call sites read as named subscriptions rather than positional
    // ones; CDK derives the logical id from the handler, which is already unique.
    void id
  }
}
