/**
 * The whole pipeline, diffed against the oracle on every golden case.
 *
 * The function-level diff in `differential.test.ts` proves the pieces agree. This proves
 * they compose: the same text in, the same items, spans, confidences, hints, rejections
 * and residual out — compared against `golden/oracle/`, the byte-frozen output CORE-01
 * recorded from the Python implementation.
 *
 * Nothing here calls the oracle. It is frozen, and its answers are committed, which is
 * what makes a frozen reference useful rather than merely retired.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { extractDeterministic } from '../src/pipeline.js'
import type { ExtractionResult, ParsedItem, RejectedItem, Span } from '../src/models.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const ORACLE_DIR = resolve(repoRoot, 'golden', 'oracle')
const EXTRACTION_DIR = resolve(repoRoot, 'golden', 'extraction')

/** Every hand-written golden case, by id. */
function handWrittenCases(): Map<string, string> {
  const cases = new Map<string, string>()
  for (const name of readdirSync(EXTRACTION_DIR).sort()) {
    if (!name.endsWith('.json')) continue
    const document = JSON.parse(readFileSync(join(EXTRACTION_DIR, name), 'utf8')) as {
      seed?: number
      cases?: { id: string; text: string }[]
    }
    // Generated corpora are not frozen against the oracle — four hundred cases that
    // change wholesale whenever the generator does. The hand-written eight are.
    if (document.seed !== undefined) continue
    for (const c of document.cases ?? []) cases.set(c.id, c.text)
  }
  return cases
}

/** The shape `tools/oracle-py/src/setlist_core/cli.py` writes. */
interface OracleOutput {
  readonly schema: number
  readonly source_kind: string
  readonly document: { digest: string; raw_length: number; text: string }
  readonly items: readonly {
    title: string
    artist: string | null
    span: Span
    confidence: number
    method: string
    parser: string
    duplicates: Span[]
    hints: Record<string, unknown>
  }[]
  readonly residual: readonly Span[]
  readonly rejected: readonly Record<string, unknown>[]
  readonly stats: Record<string, number>
}

/** Project a TypeScript result into the oracle's wire shape, field for field. */
function render(result: ExtractionResult, sourceKind: string): OracleOutput {
  const span = (s: Span): Span => ({ start: s.start, end: s.end })

  const item = (i: ParsedItem): OracleOutput['items'][number] => ({
    title: i.title,
    artist: i.artist,
    span: span(i.span),
    confidence: i.confidence,
    method: i.method,
    parser: i.parser,
    duplicates: i.duplicates.map(span),
    hints: {
      album: i.hints.album,
      year: i.hints.year,
      isrc: i.hints.isrc,
      duration_s: i.hints.durationS,
      featured_artists: [...i.hints.featuredArtists],
      qualifiers: [...i.hints.qualifiers].sort(),
      version_label: i.hints.versionLabel,
      position: i.hints.position,
      timestamp_s: i.hints.timestampS,
    },
  })

  const rejected = (r: RejectedItem): Record<string, unknown> => ({
    title: r.title,
    artist: r.artist,
    reason: r.reason,
    detail: r.detail,
    span: r.span ? span(r.span) : null,
    parser: r.parser,
  })

  return {
    schema: 1,
    source_kind: sourceKind,
    document: {
      digest: result.document.digest,
      raw_length: result.document.rawLength,
      text: result.document.text,
    },
    items: result.items.map(item),
    residual: result.residual.map(span),
    rejected: result.rejected.map(rejected),
    stats: {
      lines_total: result.stats.linesTotal,
      lines_parsed: result.stats.linesParsed,
      lines_residual: result.stats.linesResidual,
      items_before_dedupe: result.stats.itemsBeforeDedupe,
      items_after_dedupe: result.stats.itemsAfterDedupe,
      rejected: result.stats.rejected,
    },
  }
}

/** Stable serialization with keys sorted at every depth, matching the oracle's CLI. */
function canonical(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, v: unknown) => {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return v
      const record = v as Record<string, unknown>
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map(k => [k, record[k]]),
      )
    },
    2,
  )
}

const cases = handWrittenCases()
const frozen = readdirSync(ORACLE_DIR)
  .filter(name => name.endsWith('.json'))
  .sort()

describe('the frozen oracle outputs', () => {
  it('exist and cover the hand-written corpus', () => {
    // The control: every assertion below reports by absence, so an empty directory
    // would make the suite pass while comparing nothing.
    expect(frozen.length).toBeGreaterThanOrEqual(8)
    expect(cases.size).toBeGreaterThanOrEqual(8)
  })
})

describe('packages/core reproduces tools/oracle-py end to end', () => {
  for (const name of frozen) {
    const id = name.replace(/\.json$/u, '')
    it(id, () => {
      const text = cases.get(id)
      expect(text, `no golden case named ${id}`).toBeDefined()

      const expected = JSON.parse(readFileSync(join(ORACLE_DIR, name), 'utf8')) as OracleOutput
      const actual = render(extractDeterministic(text!), expected.source_kind)

      expect(canonical(actual)).toBe(canonical(expected))
    })
  }
})
