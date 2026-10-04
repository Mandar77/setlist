/**
 * Message attributes for SNS filtering (PED §10.4).
 *
 * SNS can filter on message attributes or on the payload body. Payload filtering is a
 * billed feature; attribute filtering is not. On an account with a $0 budget that is not
 * a preference, it is the only option — and the shape of the mistake is quiet, because a
 * payload filter policy works perfectly and simply costs money.
 *
 * So the attributes are derived here, from the envelope, and a subscription filters on
 * them. Deriving rather than hand-setting matters: an attribute that disagrees with the
 * body it travelled with routes a message to a consumer that then reads something else,
 * and nothing errors.
 *
 * The attributes carry the same no-content rule as the body. `type` and `env` are the
 * routing keys; neither is user input.
 */

import type { Envelope } from './envelope.js'

export interface MessageAttribute {
  readonly DataType: 'String'
  readonly StringValue: string
}

export type MessageAttributes = Readonly<Record<string, MessageAttribute>>

/** The domain segment of `setlist.<domain>.<Event>.vN`. */
export function domainOf(type: string): string {
  return type.split('.')[1] ?? ''
}

/** The attributes a publisher must attach, derived from the envelope it is sending. */
export function attributesFor(envelope: Envelope): MessageAttributes {
  const str = (StringValue: string): MessageAttribute => ({ DataType: 'String', StringValue })
  return Object.freeze({
    type: str(envelope.type),
    domain: str(domainOf(envelope.type)),
    env: str(envelope.env),
  })
}

/**
 * A subscription filter policy for one or more event types.
 *
 * Returned as a plain object so CDK can hand it straight to a subscription, and so a
 * test can assert it names only attribute keys.
 */
export function filterPolicy(types: readonly string[], env: string): Record<string, string[]> {
  return { type: [...types], env: [env] }
}
