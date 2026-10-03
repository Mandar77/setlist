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
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { extractDeterministic } from '../src/pipeline.js'
import { sha256Hex } from '../src/sha256.js'
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

/**
 * The compact canonical form `tools/oracle-py/pipeline_diff.py` hashes.
 *
 * Sorted keys, no indentation, no spacing — the parts two JSON encoders are most likely
 * to disagree about are simply absent. The suite below checks that this agrees with
 * Python on the eight golden cases before trusting it on ten thousand digests, because a
 * serialization difference would report ten thousand failures and mean nothing.
 */
function compact(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v
    const record = v as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map(k => [k, record[k]]),
    )
  })
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

// --------------------------------------------------------- the allowlist (ADR-001)

/**
 * One permitted difference between the port and the frozen oracle.
 *
 * `tools/check_diff_allowlist.js` owns the schema and the scope — that `kind` is
 * `orientation` and nothing else, that `reason` says something, that the case exists.
 * What it cannot see is whether the difference is real, so that is checked here, where
 * both outputs are in hand.
 */
interface AllowlistEntry {
  readonly case: string
  readonly items: readonly { title: string; artist: string | null; confidence: number }[]
  readonly reason: string
}

/**
 * The permitted differences, by case id.
 *
 * At CORE-04 this is empty and the loop below is a plain equality check on all eight
 * cases. It is wired up anyway: ADR-002 orientation changes arrive at CORE-05, and an
 * allowlist whose consuming code is written at the same time as its first entry is an
 * allowlist that gets written to fit the entry.
 */
function allowlist(): Map<string, AllowlistEntry> {
  // `yaml` is a dependency of infra; pnpm hoists nothing. Same resolution as
  // tools/check_workflows.js. Reaching for node: APIs is what the test-only ESLint
  // exemption is for — `src/` stays pure.
  const { parse } = createRequire(join(repoRoot, 'infra', 'package.json'))('yaml') as {
    parse: (source: string) => { entries?: AllowlistEntry[] } | null
  }
  const document = parse(readFileSync(resolve(repoRoot, 'golden', 'diff-allowlist.yaml'), 'utf8'))
  return new Map((document?.entries ?? []).map(entry => [entry.case, entry]))
}

const permitted = allowlist()

/**
 * Everything about an output that an orientation change may not touch.
 *
 * Which side of a pair is the title, obviously — and also the confidence, because
 * swapping a pair genuinely moves it. The penalties are computed on the title and the
 * artist, so reading "Justice - Genesis" the other way round makes "Justice" a
 * single-token title and takes 0.05 off. That surfaced the first time a real swap was
 * run through here: 0.92 against 0.87, on a case where nothing was wrong.
 *
 * Excusing confidence outright would be the easy fix and the wrong one — a scoring bug
 * on an allowlisted case would then pass unnoticed. So it is not excused, it is moved:
 * the entry must state the confidence it expects, and the check below holds the port to
 * that number. The oracle stops being the authority for an allowlisted item; a reviewed
 * line in a YAML file takes over.
 */
function orientationInvariant(output: OracleOutput): unknown {
  return {
    ...output,
    items: output.items.map(({ title, artist, confidence: _confidence, ...rest }) => ({
      ...rest,
      // Sorted, so a swapped pair and an unswapped one serialize identically while every
      // other field still has to match exactly.
      pair: [title, artist ?? ''].sort(),
    })),
  }
}

describe('packages/core reproduces tools/oracle-py end to end', () => {
  for (const name of frozen) {
    const id = name.replace(/\.json$/u, '')
    it(id, () => {
      const text = cases.get(id)
      expect(text, `no golden case named ${id}`).toBeDefined()

      const expected = JSON.parse(readFileSync(join(ORACLE_DIR, name), 'utf8')) as OracleOutput
      const actual = render(extractDeterministic(text!), expected.source_kind)

      const entry = permitted.get(id)
      if (entry === undefined) {
        expect(canonical(actual)).toBe(canonical(expected))
        return
      }

      // An entry for a case that no longer diverges is a standing permission nobody
      // needs, and the next real difference would slip in under it unnoticed.
      expect(
        canonical(actual),
        `${id} is on the diff allowlist but matches the oracle exactly — remove the entry`,
      ).not.toBe(canonical(expected))

      // The difference must be an orientation swap and nothing else. Spans, parsers,
      // hints, duplicates, residual, rejections and stats all still have to match: an
      // allowlisted case is permitted to read a pair the other way round, not to be
      // excused from the differential.
      expect(canonical(orientationInvariant(actual))).toBe(
        canonical(orientationInvariant(expected)),
      )

      // And it must be the swap the entry claims, confidence included, so the file says
      // what actually happens rather than merely that something does.
      expect(
        actual.items.map(i => ({ title: i.title, artist: i.artist, confidence: i.confidence })),
      ).toEqual(
        entry.items.map(i => ({ title: i.title, artist: i.artist, confidence: i.confidence })),
      )
    })
  }

  it('lists no difference that has gone away', () => {
    // The loop above only visits cases that exist. An entry naming a deleted case would
    // otherwise sit here forever, unchecked.
    for (const id of permitted.keys()) {
      expect(cases.has(id), `the allowlist names "${id}", which is not a golden case`).toBe(true)
    }
  })
})

// ------------------------------------------------- the ten thousand (ADR-001)

interface PipelineCase {
  readonly input: string
  readonly digest: string
}

const PIPELINE_FIXTURE = resolve(repoRoot, 'golden', 'diff', 'pipeline.jsonl')

const pipelineCases: PipelineCase[] = readFileSync(PIPELINE_FIXTURE, 'utf8')
  .split('\n')
  .filter(line => line.trim() !== '' && !line.startsWith('//'))
  .map(line => JSON.parse(line) as PipelineCase)

describe('the ten-thousand-input differential', () => {
  it('carries at least the ten thousand ADR-001 asks for', () => {
    // The control. The assertion below reports by absence, so an empty fixture would
    // make it pass while comparing nothing at all.
    expect(pipelineCases.length).toBeGreaterThanOrEqual(10_000)
  })

  it('agrees with Python about what canonical means', () => {
    // Checked before the digests are trusted. If the two encoders disagreed about
    // spacing or key order, every one of the ten thousand would fail for a reason that
    // has nothing to do with the port.
    for (const name of frozen.slice(0, 3)) {
      const id = name.replace(/\.json$/u, '')
      const expected = JSON.parse(readFileSync(join(ORACLE_DIR, name), 'utf8')) as OracleOutput
      const actual = render(extractDeterministic(cases.get(id)!), expected.source_kind)
      // Round-tripping the oracle's own file through `compact` gives exactly what
      // Python hashed; the port's rendering must serialize to the same bytes.
      expect(compact(actual)).toBe(compact(expected))
    }
  })

  it('reproduces the oracle on every one of them', () => {
    const wrong: string[] = []
    for (const c of pipelineCases) {
      const digest = sha256Hex(compact(render(extractDeterministic(c.input), 'printed')))
      if (digest !== c.digest) wrong.push(JSON.stringify(c.input))
      if (wrong.length >= 10) break
    }
    expect(
      wrong.length,
      `the port diverges from the oracle on these inputs:\n${wrong.join('\n')}`,
    ).toBe(0)
  })
})
