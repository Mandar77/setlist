// The generated JSON Schema, and the proof it is current.
//
// ADR-004 amended PED §10.4 to make contracts zod-first, because a hand-maintained
// Python mirror of a zod schema is the same drift problem versioning exists to prevent.
// That only holds while the generated artifact actually tracks the generator — a
// committed file nobody checks is the same drift wearing a different hat.

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { SCHEMA_PATH, buildSchema, serialize } from '../src/generate-json-schema.js'
import { EVENT_TYPES } from '../src/events.js'

describe('schemas/events.schema.json', () => {
  const committed = readFileSync(SCHEMA_PATH, 'utf8')

  it('is current with the zod schemas', () => {
    expect(
      committed,
      'run `pnpm -C packages/contracts schema` — the committed JSON Schema is stale',
    ).toBe(serialize(buildSchema()))
  })

  it('defines the envelope and every event type', () => {
    const schema = JSON.parse(committed) as { $defs: Record<string, unknown> }
    expect(schema.$defs['envelope']).toBeDefined()
    for (const type of EVENT_TYPES) {
      expect(schema.$defs[type], `${type} is missing from the generated schema`).toBeDefined()
    }
  })

  it('says it is generated, so nobody edits it by hand', () => {
    expect(committed).toContain('Do not edit by hand')
  })

  it('the staleness check can fail', () => {
    // Without this, "is current" would pass for a comparison that could not differ — the
    // shape of check this repository has found reporting success five times over.
    const drifted = serialize({ ...(buildSchema() as object), title: 'something else' })
    expect(drifted).not.toBe(committed)
  })
})
