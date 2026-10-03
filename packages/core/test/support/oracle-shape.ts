/**
 * The oracle's wire shape, and how a TypeScript result is projected into it.
 *
 * Shared by the two suites that compare against `golden/oracle/`: the golden-case diff in
 * `pipeline-differential.test.ts` and the ten-thousand-input diff in
 * `pipeline-10k.test.ts`. They were one file until the mutation run showed they cannot
 * be — see that second file for why — and the projection has to stay identical across
 * both or the two would be comparing different things.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { ExtractionResult, ParsedItem, RejectedItem, Span } from '../../src/models.js'
import { repoRoot } from './repo-root.js'

export const ORACLE_DIR = resolve(repoRoot, 'golden', 'oracle')
const EXTRACTION_DIR = resolve(repoRoot, 'golden', 'extraction')

/** The shape `tools/oracle-py/src/setlist_core/cli.py` writes. */
export interface OracleOutput {
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

/** Every hand-written golden case, by id. */
export function handWrittenCases(): Map<string, string> {
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

/** The frozen oracle outputs, by filename. */
export function frozenOutputs(): string[] {
  return readdirSync(ORACLE_DIR)
    .filter(name => name.endsWith('.json'))
    .sort()
}

/** Project a TypeScript result into the oracle's wire shape, field for field. */
export function render(result: ExtractionResult, sourceKind: string): OracleOutput {
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

/** Sort every object's keys, at every depth. */
const sortKeys = (_key: string, value: unknown): unknown => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map(k => [k, record[k]]),
  )
}

/** Readable serialization with keys sorted at every depth; used for assertion diffs. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, sortKeys, 2)
}

/**
 * The compact canonical form `tools/oracle-py/pipeline_diff.py` hashes.
 *
 * Sorted keys, no indentation, no spacing — the parts two JSON encoders are most likely
 * to disagree about are simply absent.
 */
export function compact(value: unknown): string {
  return JSON.stringify(value, sortKeys)
}
