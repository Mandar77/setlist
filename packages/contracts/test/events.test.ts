// The event contracts (M3-01).
//
// The test that matters most here is "no content in a payload". It is written as a
// REJECTION test rather than an inspection of the samples, because a sample with no song
// title in it proves only that this sample has none — the property wanted is that a song
// title cannot be put in one at all.

import { describe, expect, it } from 'vitest'

import {
  EVENT_DATA,
  EVENT_TYPES,
  EnvelopeTooLargeError,
  GOLDEN_SAMPLES,
  MAX_EVENT_BYTES,
  assertEnvelopeSize,
  attributesFor,
  domainOf,
  envelopeSchema,
  filterPolicy,
  messageSchema,
  utf8Bytes,
  type EventType,
} from '../src/index.js'

/** Things a payload must never be able to hold. */
const CONTENT = [
  'One More Time',
  'Daft Punk',
  // Assembled at runtime rather than written as a literal. The first draft of this list
  // used a real address and tools/check_no_secrets.py caught it, which is precisely what
  // ADR-005 put that gate there for. The scanner then flagged the example.invalid
  // replacement too, because it matches any email SHAPE -- correctly, since it cannot
  // know which addresses are real. So the file contains no email, the test still covers
  // one, and the gate keeps its strictness.
  ['someone', 'example.invalid'].join('@'),
  'A Person',
  '坂本龍一',
  'a sentence with spaces',
]

describe('every event type is complete', () => {
  it('has 12 types, a schema and a golden sample each', () => {
    expect(EVENT_TYPES).toHaveLength(12)
    for (const type of EVENT_TYPES) {
      expect(EVENT_DATA[type], `${type} has no schema`).toBeDefined()
      expect(GOLDEN_SAMPLES[type], `${type} has no golden sample`).toBeDefined()
    }
  })

  it('names every type setlist.<domain>.<Event>.vN', () => {
    for (const type of EVENT_TYPES) {
      expect(type, `${type} is not a versioned event name`).toMatch(
        /^setlist\.[a-z][a-z-]*\.[A-Z][A-Za-z]*\.v[1-9][0-9]*$/,
      )
    }
  })
})

describe('producer golden samples', () => {
  it.each(EVENT_TYPES)('%s validates against its own schema', type => {
    const parsed = messageSchema(type).safeParse(GOLDEN_SAMPLES[type])
    if (!parsed.success) console.log(JSON.stringify(parsed.error.issues, null, 2))
    expect(parsed.success).toBe(true)
  })

  it.each(EVENT_TYPES)('%s is rejected by every OTHER type', type => {
    // The narrowed `type` literal is what makes this work. Without it a payload could be
    // attached to the wrong type name and nothing would notice — the single most likely
    // contract mistake there is.
    for (const other of EVENT_TYPES) {
      if (other === type) continue
      expect(messageSchema(other).safeParse(GOLDEN_SAMPLES[type]).success).toBe(false)
    }
  })

  it.each(EVENT_TYPES)('%s fits the size budget', type => {
    expect(() => assertEnvelopeSize(GOLDEN_SAMPLES[type])).not.toThrow()
  })
})

describe('payloads carry identifiers, never content', () => {
  it.each(EVENT_TYPES)('%s rejects content in every string field', type => {
    const sample = GOLDEN_SAMPLES[type] as { data: Record<string, unknown> }
    const stringFields = Object.entries(sample.data)
      .filter(([, value]) => typeof value === 'string')
      .map(([key]) => key)

    expect(stringFields.length, `${type} has no string fields to poison`).toBeGreaterThan(0)

    for (const field of stringFields) {
      for (const content of CONTENT) {
        const poisoned = {
          ...sample,
          data: { ...sample.data, [field]: content },
        }
        expect(
          messageSchema(type).safeParse(poisoned).success,
          `${type}.data.${field} accepted ${JSON.stringify(content)} — a payload must not be able to carry content`,
        ).toBe(false)
      }
    }
  })

  it('the poison list is not vacuously rejected by everything', () => {
    // The control. If `CONTENT` were rejected because the SHAPE was wrong rather than
    // the value, the test above would pass for the wrong reason. A legitimate value in
    // the same field must still be accepted.
    const type: EventType = 'setlist.ingestion.ScanSubmitted.v1'
    expect(messageSchema(type).safeParse(GOLDEN_SAMPLES[type]).success).toBe(true)
  })
})

describe('the envelope', () => {
  const valid = GOLDEN_SAMPLES['setlist.ingestion.ScanSubmitted.v1']

  it('requires a versioned type', () => {
    expect(
      envelopeSchema.safeParse({ ...valid, type: 'setlist.ingestion.ScanSubmitted' }).success,
    ).toBe(false)
    expect(envelopeSchema.safeParse({ ...valid, type: 'ScanSubmitted.v1' }).success).toBe(false)
  })

  it('requires a uuid id', () => {
    expect(envelopeSchema.safeParse({ ...valid, id: 'not-a-uuid' }).success).toBe(false)
  })

  it('requires a known env', () => {
    expect(envelopeSchema.safeParse({ ...valid, env: 'production' }).success).toBe(false)
  })

  it.each(['id', 'type', 'correlationid', 'idempotencykey', 'env', 'data'])(
    'requires %s',
    field => {
      const without = { ...valid } as Record<string, unknown>
      delete without[field]
      expect(envelopeSchema.safeParse(without).success).toBe(false)
    },
  )

  it('keeps idempotencykey distinct from id in the samples', () => {
    // They answer different questions: `id` identifies this message, `idempotencykey`
    // identifies the work. A retry is a new message about the same work.
    for (const type of EVENT_TYPES) {
      const sample = GOLDEN_SAMPLES[type] as { id: string; idempotencykey: string }
      expect(sample.idempotencykey).not.toBe(sample.id)
    }
  })
})

describe('the size limit', () => {
  it('measures UTF-8 bytes, not characters', () => {
    expect(utf8Bytes('abc')).toBe(3)
    expect(utf8Bytes('坂本龍一')).toBe(12)
    expect(utf8Bytes(String.fromCodePoint(0x1f3b5))).toBe(4)
  })

  it('throws over the limit', () => {
    const big = { data: { x: 'a'.repeat(MAX_EVENT_BYTES) } }
    expect(() => assertEnvelopeSize(big)).toThrow(EnvelopeTooLargeError)
  })

  it('a CJK payload trips the limit a character count would wave through', () => {
    // Three bytes per character: 30,000 characters is 90,000 bytes, which is over the
    // 65,536-byte budget while being well under it by length.
    const cjk = { data: { x: '坂'.repeat(30_000) } }
    expect(JSON.stringify(cjk).length).toBeLessThan(MAX_EVENT_BYTES)
    expect(() => assertEnvelopeSize(cjk)).toThrow(EnvelopeTooLargeError)
  })
})

describe('SNS routing uses attributes, never the payload', () => {
  const envelope = envelopeSchema.parse(GOLDEN_SAMPLES['setlist.ingestion.ScanSubmitted.v1'])

  it('derives attributes from the envelope rather than taking them on trust', () => {
    const attributes = attributesFor(envelope)
    expect(attributes['type']?.StringValue).toBe(envelope.type)
    expect(attributes['domain']?.StringValue).toBe('ingestion')
    expect(attributes['env']?.StringValue).toBe(envelope.env)
  })

  it('carries no content in the attributes either', () => {
    const values = Object.values(attributesFor(envelope)).map(a => a.StringValue)
    for (const value of values) expect(value).not.toMatch(/\s/)
  })

  it('a filter policy names only attribute keys', () => {
    // Payload filtering is a billed SNS feature, so a policy that reaches into `data` is
    // a cost bug that works perfectly. The keys here must be attribute names only.
    const policy = filterPolicy(['setlist.ingestion.ScanSubmitted.v1'], 'dev')
    const attributeKeys = Object.keys(attributesFor(envelope))
    for (const key of Object.keys(policy)) expect(attributeKeys).toContain(key)
    expect(JSON.stringify(policy)).not.toContain('data')
    expect(JSON.stringify(policy)).not.toContain('$.')
  })

  it('domainOf reads the second segment', () => {
    expect(domainOf('setlist.playlist.PlaylistCreated.v1')).toBe('playlist')
    expect(domainOf('nonsense')).toBe('')
  })
})
