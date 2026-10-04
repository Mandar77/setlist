/**
 * The versioned event schemas (PED §10.3 service table, §10.4 contracts).
 *
 * ## Payloads carry identifiers, never content
 *
 * This is the rule the whole file is shaped around, and it is a privacy decision before
 * it is a size one. An event body may contain ids, counts, enums, timestamps and
 * currency-free numbers. It may not contain a song title, an artist name, an email, a
 * display name, or any other thing a person typed or a scan produced.
 *
 * The reason is that events fan out. They land in SNS, in Lambda logs, in a DLQ that
 * outlives the request, and eventually in the analytics ETL — each one a copy of the
 * payload in a place with its own retention and its own access rules. Song titles are
 * user content (PRD §10 treats pasted text as untrusted and private), so the cheapest
 * correct answer is that they never enter the pipe at all. A consumer that needs the
 * songs reads them from DynamoDB under the scan id, where they are written once and
 * deleted on the user's schedule.
 *
 * That rule is enforced structurally rather than by review. Every string field below is
 * a `ulid`, a `uuid`, an enum, or a bounded token with no spaces — so a title cannot be
 * put in one even by accident, and `events.test.ts` proves it by trying.
 */

import { z } from 'zod'

import { envelopeSchema } from './envelope.js'

/**
 * A ULID or UUID. Both appear: ULIDs for records this system creates (sortable by time,
 * which the single-table design uses as a range key), UUIDs where a provider or Cognito
 * supplies the identifier.
 */
const ID = z
  .string()
  .regex(
    /^(?:[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
    'must be a ULID or a UUID',
  )

/** A short opaque token: provider ids, playlist ids, flag names. No whitespace. */
const TOKEN = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'must not contain whitespace')

/** A non-negative count. */
const COUNT = z.number().int().nonnegative()

/** An ISO-8601 instant. */
const TIMESTAMP = z.string().datetime()

export const PROVIDERS = ['youtube', 'spotify', 'apple', 'amazon'] as const
export const SOURCE_KINDS = [
  'scan_handwriting',
  'scan_print',
  'screenshot',
  'paste',
  'file',
] as const

/** Every event's `data`, by type. */
export const EVENT_DATA = {
  'setlist.identity.UserDeleted.v1': z.object({
    userId: ID,
    deletedAt: TIMESTAMP,
  }),

  'setlist.provider.ProviderConnected.v1': z.object({
    userId: ID,
    provider: z.enum(PROVIDERS),
    connectionId: ID,
  }),

  'setlist.provider.ProviderTokenRevoked.v1': z.object({
    userId: ID,
    provider: z.enum(PROVIDERS),
    connectionId: ID,
    reason: z.enum(['user_revoked', 'expired', 'provider_error', 'kill_switch']),
  }),

  'setlist.ingestion.ScanSubmitted.v1': z.object({
    scanId: ID,
    userId: ID,
    sourceKind: z.enum(SOURCE_KINDS),
    /** Identifies the submitted text without reproducing it. */
    textDigest: z.string().regex(/^[0-9a-f]{64}$/, 'must be a sha256 hex digest'),
    byteLength: COUNT,
  }),

  'setlist.extraction.SongsExtracted.v1': z.object({
    scanId: ID,
    userId: ID,
    /** Counts, not songs. The items live under the scan id in DynamoDB. */
    itemCount: COUNT,
    rejectedCount: COUNT,
    residualCount: COUNT,
    deterministicCoverage: z.number().min(0).max(1),
  }),

  'setlist.matching.SongsMatched.v1': z.object({
    scanId: ID,
    userId: ID,
    matchedCount: COUNT,
    unmatchedCount: COUNT,
    needsReviewCount: COUNT,
  }),

  'setlist.playlist.CreatePlaylistRequested.v1': z.object({
    jobId: ID,
    scanId: ID,
    userId: ID,
    provider: z.enum(PROVIDERS),
    trackCount: COUNT,
  }),

  'setlist.playlist.PlaylistCreated.v1': z.object({
    jobId: ID,
    userId: ID,
    provider: z.enum(PROVIDERS),
    /** The provider's own id for the playlist. Not its name. */
    providerPlaylistId: TOKEN,
    trackCount: COUNT,
  }),

  'setlist.playlist.JobCompleted.v1': z.object({
    jobId: ID,
    userId: ID,
    outcome: z.enum(['succeeded', 'partial', 'failed', 'cancelled']),
    trackCount: COUNT,
    failedCount: COUNT,
  }),

  'setlist.provider.ProviderCallFailed.v1': z.object({
    jobId: ID,
    provider: z.enum(PROVIDERS),
    /** The provider's status code, not its message — messages quote user input. */
    statusCode: z.number().int().min(100).max(599),
    reason: z.enum(['quota', 'rate_limit', 'auth', 'not_found', 'server', 'unknown']),
    retryable: z.boolean(),
  }),

  'setlist.analytics.UsageThresholdCrossed.v1': z.object({
    limitName: TOKEN,
    env: z.enum(['dev', 'stage', 'prod']),
    sharePct: z.number().min(0),
    threshold: z.number().min(0),
  }),

  'setlist.config.FlagChanged.v1': z.object({
    flag: TOKEN,
    env: z.enum(['dev', 'stage', 'prod']),
    enabled: z.boolean(),
    changedAt: TIMESTAMP,
  }),
} as const

export type EventType = keyof typeof EVENT_DATA

/** Every event type, for tests and for the JSON Schema generator. */
export const EVENT_TYPES = Object.keys(EVENT_DATA) as EventType[]

/**
 * The full message for one event type: the shared envelope with `data` narrowed.
 *
 * `type` is narrowed to the literal too, so a payload cannot be attached to the wrong
 * type name — the single most likely contract mistake, and one a shared envelope with a
 * loose `data` would not catch.
 */
export function messageSchema<T extends EventType>(
  type: T,
): z.ZodObject<{ type: z.ZodLiteral<T>; data: (typeof EVENT_DATA)[T] }> {
  return envelopeSchema.extend({
    type: z.literal(type),
    data: EVENT_DATA[type],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any
}
