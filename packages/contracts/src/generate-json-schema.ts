/**
 * Generate the JSON Schema the Python consumers read, from the zod schemas.
 *
 *   pnpm -C packages/contracts schema          # write
 *   pnpm -C packages/contracts schema --check  # fail if the committed file is stale
 *
 * ADR-004 amended PED §10.4 to make contracts zod-first: a hand-maintained Python mirror
 * of a zod schema is the same drift problem versioning exists to prevent. So this is the
 * one direction of truth, and `schemas/events.schema.json` is committed output.
 *
 * Committed rather than generated at build time for the same reason the KICS queries, the
 * bootstrap template and the frozen oracle outputs are committed: the artifact can be
 * read and reviewed, and a check proves nobody edited it by hand and that it did not
 * drift when its generator did. `--check` is that proof and runs in the package's tests.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { z } from 'zod'

import { EVENT_DATA, EVENT_TYPES } from './events.js'
import { envelopeSchema } from './envelope.js'

const here = dirname(fileURLToPath(import.meta.url))
export const SCHEMA_PATH = join(here, '..', 'schemas', 'events.schema.json')

/** One document with the envelope and every event's `data`, keyed by type. */
export function buildSchema(): unknown {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://setlist.invalid/schemas/events.schema.json',
    title: 'Setlist event contracts',
    description:
      'Generated from packages/contracts/src by `pnpm -C packages/contracts schema`. ' +
      'Do not edit by hand; the generator is the source of truth (ADR-004).',
    $defs: {
      envelope: z.toJSONSchema(envelopeSchema, { target: 'draft-2020-12' }),
      ...Object.fromEntries(
        EVENT_TYPES.map(type => [
          type,
          z.toJSONSchema(EVENT_DATA[type], { target: 'draft-2020-12' }),
        ]),
      ),
    },
  }
}

/** Stable serialization: two bytes of whitespace difference is not a contract change. */
export function serialize(schema: unknown): string {
  return `${JSON.stringify(schema, null, 2)}\n`
}

export function readCommitted(): string | null {
  return existsSync(SCHEMA_PATH) ? readFileSync(SCHEMA_PATH, 'utf8') : null
}

function main(): void {
  const next = serialize(buildSchema())
  const check = process.argv.includes('--check')

  if (check) {
    const current = readCommitted()
    if (current === next) {
      console.log(`schemas/events.schema.json is current (${EVENT_TYPES.length} event types)`)
      return
    }
    console.error(
      current === null
        ? 'schemas/events.schema.json is missing — run `pnpm -C packages/contracts schema`'
        : 'schemas/events.schema.json is stale — run `pnpm -C packages/contracts schema`',
    )
    process.exit(1)
  }

  mkdirSync(dirname(SCHEMA_PATH), { recursive: true })
  writeFileSync(SCHEMA_PATH, next)
  console.log(`wrote schemas/events.schema.json (${EVENT_TYPES.length} event types)`)
}

// Only when run directly, so importing this from a test does not write files.
//
// Compared as resolved paths rather than by string suffix: the first version used
// `import.meta.url.endsWith(argv[1])`, which is false on Windows because the URL has
// forward slashes and `argv[1]` has backslashes — so the generator silently did nothing
// and reported success.
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) main()
