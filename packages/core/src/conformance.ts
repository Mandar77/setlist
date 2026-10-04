/**
 * The engine conformance suite (CORE-06), as a reusable pure function.
 *
 * ADR-001 requires parity on all three engines the core actually runs on: Node, Chromium
 * and Hermes. The thing that makes that checkable is that the suite itself has no I/O —
 * cases are passed in, results are returned, and the caller decides where the data came
 * from and how to report. A suite that read `golden/` with `node:fs` could only ever run
 * in one of the three places.
 *
 * So this module is the contract, and the runners are thin:
 *
 *   * Node: `test/conformance.test.ts` reads `golden/oracle/` and calls it.
 *   * Chromium: a Playwright runner bundles this plus the cases and evaluates it.
 *   * Hermes: M1-04's dev-only self-test screen imports it and renders the result.
 *
 * ADR-001 names this as the most likely source of a real divergence, and names the two
 * suspects: NFKC, and regex Unicode property escapes. Those get their own checks rather
 * than being left to show up as a mangled title — `unicodeConformance()` asks the engine
 * directly, so a failure says "this engine's `\p{Lu}` is wrong" instead of "case 4
 * differs".
 */

import { extractDeterministic } from './pipeline.js'
import type { SourceKind } from './enums.js'
import type { ExtractionResult, ParsedItem, RejectedItem, Span } from './models.js'

/** One golden case: the input, and the canonical JSON the oracle produced for it. */
export interface ConformanceCase {
  readonly name: string
  readonly text: string
  readonly sourceKind: string
  /** The expected output, already canonicalized by the caller. */
  readonly expected: string
}

export interface ConformanceFailure {
  readonly name: string
  readonly reason: string
  /** Present for an output mismatch; absent for a thrown error. */
  readonly expected?: string
  readonly actual?: string
}

export interface ConformanceReport {
  readonly engine: string
  readonly total: number
  readonly passed: number
  readonly failures: readonly ConformanceFailure[]
  readonly unicode: readonly ConformanceFailure[]
  readonly ok: boolean
}

/**
 * Canonical JSON: object keys sorted, every level, no incidental whitespace.
 *
 * Duplicated deliberately from the test helper rather than imported from it. This has to
 * run in a browser and on Hermes, where `test/support/` is not reachable, and a
 * conformance suite that depends on the test harness is not a conformance suite.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
  return `{${entries.join(',')}}`
}

/**
 * The two engine behaviours ADR-001 flags, asked directly.
 *
 * Every one of these is a thing that has actually differed between JavaScript engines or
 * between JavaScript and Python, and each would otherwise surface as an unexplained
 * golden-case mismatch several layers up.
 */
export function unicodeConformance(): ConformanceFailure[] {
  const failures: ConformanceFailure[] = []
  const check = (name: string, actual: string, expected: string): void => {
    if (actual !== expected) failures.push({ name, reason: 'engine behaviour', expected, actual })
  }

  // Every operand is built from code points, never written as a literal. The first
  // draft used escapes, the formatter rewrote them into the characters they stand for,
  // and `e + combining acute` became a precomposed e-acute -- so the composition check
  // read `x === x` and asserted nothing. The same pass turned a U+001F escape into a
  // literal control character sitting in the source file.
  const cp = (...points: number[]): string => String.fromCodePoint(...points)

  // NFKC is the normalization the span contract is defined in terms of. Hermes has
  // shipped without a full ICU in the past, and a stubbed `normalize` that returns its
  // input would pass every test that does not check it directly.
  check('NFKC composes e + combining acute', cp(0x65, 0x301).normalize('NFKC'), cp(0xe9))
  check('NFKC folds a fullwidth capital', cp(0xff21).normalize('NFKC'), 'A')
  check('NFKC expands the fi ligature', cp(0xfb01).normalize('NFKC'), 'fi')
  // The canonical-ordering case from ADR-009: ccc 220 sorts before ccc 230.
  check(
    'NFKC reorders combining marks by class',
    cp(0x301, 0x1a7f).normalize('NFKC'),
    cp(0x1a7f, 0x301),
  )
  check('NFKC is available at all', typeof ''.normalize === 'function' ? 'yes' : 'no', 'yes')

  // Regex Unicode property escapes. The parsers are built from these -- \p{L} stands in
  // for Python's Unicode-aware \w, and an engine without them would silently match
  // ASCII only, collapsing every non-Latin title.
  check('Lu matches a Greek capital', String(/\p{Lu}/u.test(cp(0x394))), 'true')
  check('L matches Cyrillic', String(/\p{L}/u.test(cp(0x41f))), 'true')
  check('L matches CJK', String(/\p{L}/u.test(cp(0x4e16))), 'true')
  check('N matches an Arabic-Indic digit', String(/\p{N}/u.test(cp(0x663))), 'true')
  check('Cc matches a control character', String(/\p{Cc}/u.test(cp(0x1f))), 'true')
  check('L does NOT match punctuation', String(/\p{L}/u.test('-')), 'false')

  // Lookbehind, which the word-boundary replacements depend on. Older engines lacked it.
  check('lookbehind is supported', String(/(?<![a-z])x/u.test('x')), 'true')
  return failures
}

/**
 * Project a result into the oracle's wire shape, field for field.
 *
 * Lives here rather than in `test/support` because a Chromium or Hermes runner cannot
 * reach the test harness, and a conformance suite that depends on it is not portable.
 * `test/support/oracle-shape.ts` keeps its own copy for the differential, and
 * `conformance.test.ts` asserts the two agree — two renderers that silently drifted
 * would make this suite measure the wrong shape.
 */
export function renderOracleShape(result: ExtractionResult, sourceKind: string): unknown {
  const span = (s: Span): { start: number; end: number } => ({ start: s.start, end: s.end })

  const item = (i: ParsedItem): unknown => ({
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

  const rejected = (r: RejectedItem): unknown => ({
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

/**
 * Run the golden cases and report what differs.
 *
 * `engine` is a label the caller supplies — "node", "chromium", "hermes" — so a report
 * read in isolation says where it came from.
 */
export function runConformance(
  cases: readonly ConformanceCase[],
  engine: string,
  render: (result: ExtractionResult, sourceKind: string) => unknown = renderOracleShape,
): ConformanceReport {
  const failures: ConformanceFailure[] = []
  let passed = 0

  for (const testCase of cases) {
    try {
      const result = extractDeterministic(testCase.text, {
        sourceKind: testCase.sourceKind as SourceKind,
      })
      const actual = canonicalJson(render(result, testCase.sourceKind))
      if (actual === testCase.expected) passed += 1
      else
        failures.push({
          name: testCase.name,
          reason: 'output differs',
          expected: testCase.expected,
          actual,
        })
    } catch (error) {
      failures.push({
        name: testCase.name,
        reason: `threw: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  const unicode = unicodeConformance()
  return {
    engine,
    total: cases.length,
    passed,
    failures,
    unicode,
    // An empty case list is not a pass. A runner that failed to load its data would
    // otherwise report a clean sweep of nothing, which is this repository's most
    // frequently repeated bug.
    ok: cases.length > 0 && failures.length === 0 && unicode.length === 0,
  }
}
