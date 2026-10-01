/**
 * ProfileAwareFactory — the one place the two profiles diverge.
 *
 * PED G5 is "one codebase, two profiles". That only holds if the differences live in a
 * single seam. Scatter `if (profile === 'zero')` through the stacks and the enterprise
 * path rots silently, because nothing exercises it; concentrate them here and both
 * paths synthesize in CI on every commit.
 *
 * The substitutions, and what each one costs if taken the other way:
 *
 * | Concern       | zero                         | enterprise          | why not always enterprise |
 * | ------------- | ---------------------------- | ------------------- | ------------------------- |
 * | Sync API      | Lambda Function URL + OAC    | API Gateway         | API Gateway's free tier is 12-month/credits only (PED D1) |
 * | Events        | SNS topic                    | EventBridge bus     | custom bus events have no free tier at all (D3) |
 * | Orchestration | Lambda saga, state in DynamoDB | Step Functions    | 4,000 free transitions; ~8/job is ~250 jobs/month (D4) |
 * | Fan-out       | SNS -> Lambda + DLQ          | SQS event source    | an idle poller burns ~130k requests/month (D5) |
 *
 * Nothing here provisions the platform; M0A-06 does that. This decides, and returns
 * constructs, so the decision is testable on its own.
 */

import { Duration, Stack } from 'aws-cdk-lib'
import { EventBus } from 'aws-cdk-lib/aws-events'
import { Topic } from 'aws-cdk-lib/aws-sns'
import { Queue } from 'aws-cdk-lib/aws-sqs'
import type { Construct } from 'constructs'
import type { EnvName } from '../config/budget.js'
import type { Profile } from '../config/profile.js'

export type EventTransport = 'sns' | 'eventbridge'
export type SyncTransport = 'function-url' | 'api-gateway'
export type Orchestrator = 'lambda-saga' | 'step-functions'
export type FanOut = 'sns-direct' | 'sqs-event-source'

/** The full set of choices a profile implies. Pure data: trivially assertable. */
export interface TransportChoices {
  readonly events: EventTransport
  readonly sync: SyncTransport
  readonly orchestrator: Orchestrator
  readonly fanOut: FanOut
}

const CHOICES: Record<Profile, TransportChoices> = {
  zero: {
    events: 'sns',
    sync: 'function-url',
    orchestrator: 'lambda-saga',
    fanOut: 'sns-direct',
  },
  enterprise: {
    events: 'eventbridge',
    sync: 'api-gateway',
    orchestrator: 'step-functions',
    fanOut: 'sqs-event-source',
  },
}

/** What a profile implies, without building anything. */
export function transportChoices(profile: Profile): TransportChoices {
  return CHOICES[profile]
}

/** The domain event bus, whichever shape this profile gives it. */
export interface DomainBus {
  readonly kind: EventTransport
  /** Present under `zero`. */
  readonly topic?: Topic
  /** Present under `enterprise`. */
  readonly bus?: EventBus
  /** Where a failed async invoke lands. Present in both profiles. */
  readonly deadLetterQueue: Queue
}

export interface FactoryProps {
  readonly profile: Profile
  readonly env: EnvName
}

export class ProfileAwareFactory {
  readonly profile: Profile
  readonly env: EnvName
  readonly choices: TransportChoices

  constructor(props: FactoryProps) {
    this.profile = props.profile
    this.env = props.env
    this.choices = transportChoices(props.profile)
  }

  get isZero(): boolean {
    return this.profile === 'zero'
  }

  /**
   * Create the domain event bus.
   *
   * Under `zero` this is an SNS topic: SNS publishes are always free and delivery to
   * Lambda carries no per-message charge. Under `enterprise` it is an EventBridge bus,
   * which buys schema discovery and content filtering — and a per-million-events bill
   * that has no free tier.
   *
   * Both profiles get a dead-letter queue. DLQ *receives* are negligible; it is idle
   * event-source-mapping pollers that burn the SQS allowance, and this is not one.
   */
  domainBus(scope: Construct, id: string): DomainBus {
    const deadLetterQueue = new Queue(scope, `${id}Dlq`, {
      queueName: `setlist-${this.env}-${id.toLowerCase()}-dlq`,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    })

    if (this.choices.events === 'sns') {
      return {
        kind: 'sns',
        topic: new Topic(scope, id, {
          topicName: `setlist-${this.env}-${id.toLowerCase()}`,
          // Message-attribute filtering only. Payload-based filtering is billed, and
          // a subscription filter is not worth a line item.
          displayName: `Setlist ${this.env} ${id}`,
        }),
        deadLetterQueue,
      }
    }

    return {
      kind: 'eventbridge',
      bus: new EventBus(scope, id, { eventBusName: `setlist-${this.env}-${id.toLowerCase()}` }),
      deadLetterQueue,
    }
  }

  /**
   * Assert a construct is allowed under this profile.
   *
   * Used by stacks that can build something expensive, so the refusal happens at synth
   * with a reason attached rather than at deploy with a quota error — or worse, at the
   * end of the month.
   */
  requireEnterprise(scope: Construct, what: string): void {
    if (this.isZero) {
      throw new Error(
        `${what} is not available under profile=zero (${Stack.of(scope).stackName}). ` +
          'It has no free tier. Run with -c profile=enterprise only if the human asked ' +
          'for it this session — see CLAUDE.md.',
      )
    }
  }
}
