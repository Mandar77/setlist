/**
 * The event envelope every message in this system carries (PED §10.4).
 *
 * CloudEvents-style rather than CloudEvents proper: the field set is theirs, the
 * serialization is plain JSON on an SNS topic. Five fields plus `data`, and each one is
 * here because something downstream cannot work without it.
 *
 * ## Why the field names are lowercase and unpunctuated
 *
 * `correlationid`, not `correlationId` or `correlation_id`. CloudEvents reserves
 * lowercase alphanumeric attribute names, and more practically these cross a TypeScript
 * producer and a Python consumer — a casing convention that is idiomatic on one side is
 * wrong on the other, so neither side gets its preference and both get the same string.
 *
 * ## The size limit is a hard one
 *
 * SNS rejects a message over 256 KB outright, but the free-tier accounting in PED §6
 * assumes ≤64 KB, and a message that is accepted but unbudgeted is worse than one that
 * fails loudly. `assertEnvelopeSize` is the check, and it measures UTF-8 bytes rather
 * than string length: a payload of CJK titles is three times its character count, which
 * is exactly the case a length check would wave through.
 */

import { z } from 'zod'

/** Environments an event can be emitted in. `prod` is never written from a test. */
export const ENVIRONMENTS = ['dev', 'stage', 'prod'] as const
export type Environment = (typeof ENVIRONMENTS)[number]

/**
 * `setlist.<domain>.<Event>.vN`.
 *
 * Anchored, and the version suffix is mandatory. An unversioned type is how a breaking
 * change ships without anyone deciding to make one — PED §10.4 requires vN+1 and a
 * release of dual publication, and neither is possible if the version is not in the name.
 */
export const EVENT_TYPE_RE = /^setlist\.[a-z][a-z-]*\.[A-Z][A-Za-z]*\.v[1-9][0-9]*$/

/** The maximum serialized size of one event, in UTF-8 bytes. */
export const MAX_EVENT_BYTES = 64 * 1024

export const envelopeSchema = z.object({
  /** Unique per event. Powertools `@idempotent` keys on this for retries. */
  id: z.string().uuid(),
  type: z.string().regex(EVENT_TYPE_RE, 'must be setlist.<domain>.<Event>.vN'),
  /** Ties every event in one user action together across services. */
  correlationid: z.string().min(1).max(128),
  /**
   * Stable across retries of the same logical operation, and DIFFERENT from `id`.
   *
   * `id` identifies this message; `idempotencykey` identifies the work. A retry is a new
   * message about the same work, so collapsing the two would make every retry look like
   * a fresh request.
   */
  idempotencykey: z.string().min(1).max(256),
  env: z.enum(ENVIRONMENTS),
  data: z.record(z.string(), z.unknown()),
})

export type Envelope = z.infer<typeof envelopeSchema>

/** UTF-8 byte length, without TextEncoder — the same reason as in the core. */
export function utf8Bytes(text: string): number {
  let bytes = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

export class EnvelopeTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(`event is ${bytes} bytes, over the ${limit}-byte limit`)
    this.name = 'EnvelopeTooLargeError'
  }
}

/** Throw if the serialized event exceeds the budgeted size. */
export function assertEnvelopeSize(envelope: unknown, limit = MAX_EVENT_BYTES): void {
  const bytes = utf8Bytes(JSON.stringify(envelope))
  if (bytes > limit) throw new EnvelopeTooLargeError(bytes, limit)
}
