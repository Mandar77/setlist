/**
 * The report, and the regression check that makes it a gate rather than a reading.
 *
 * `docs/reports/ocr-eval.md` is written by the harness and compared against the previous
 * one. A nightly number nobody diffs is a number nobody reads — M2-05a's fourth
 * done_when exists for that reason, and this file is where it is honoured.
 */

import type { ClassScore, EngineScore } from './evaluate.js'

/** How much a metric may move before it is called a regression rather than noise. */
export const REGRESSION_EPSILON = 0.01

/**
 * The M3 handwriting floor, borrowed by ADR-015 as the routing test.
 *
 * Below this on synthetic handwriting — the best case — handwriting scans default to the
 * server engine. Chosen before any engine had run, so it could not be fitted to a result.
 */
export const HANDWRITING_FLOOR = 0.78

const pct = (value: number): string => `${(value * 100).toFixed(2)}%`
const ms = (value: number | null): string => (value === null ? '—' : `${Math.round(value)} ms`)

/**
 * ADR-015 fixes the column order: song-level F1 is the headline, CER and WER are
 * diagnostics. Order is not cosmetic here — the first numeric column is the one people
 * compare engines on, and putting CER there invites deciding on the diagnostic.
 */
function row(engine: string, score: ClassScore): string {
  const label = score.imageClass === 'handwriting' ? 'handwriting (best case)' : score.imageClass
  return (
    `| ${engine} | ${label} | ${score.images} | ${score.songF1.toFixed(3)} | ` +
    `${score.precision.toFixed(3)} | ${score.recall.toFixed(3)} | ${pct(score.fallbackShare)} | ` +
    `${pct(score.cer)} | ${pct(score.wer)} | ${ms(score.medianMs)} | ${score.emptyImages} |`
  )
}

export interface Regression {
  readonly engine: string
  readonly imageClass: string
  readonly metric: string
  readonly before: number
  readonly after: number
}

/**
 * Previous-run numbers, keyed `engine/class/metric`.
 *
 * Parsed back out of the committed markdown rather than kept in a second JSON file. One
 * artifact means the thing a reviewer reads and the thing the gate compares cannot
 * disagree — and a JSON sidecar that drifted from the table would make the report look
 * authoritative while the gate used something else.
 */
export function parsePrevious(markdown: string): Map<string, number> {
  const previous = new Map<string, number>()
  for (const line of markdown.split('\n')) {
    const cells = line.split('|').map(cell => cell.trim())
    // | engine | class | images | f1 | p | r | fallback | cer | wer | ms | empty |
    if (cells.length < 12) continue
    const [, engine, rawClass, , f1Cell, , , , cerCell, werCell] = cells
    if (engine === undefined || engine === 'Engine' || engine.startsWith('-')) continue
    // The table labels handwriting "handwriting (best case)" per ADR-015. The key has to
    // be the bare class or every comparison against a previous run misses silently —
    // which `findRegressions` would report as "no previous value", i.e. as a pass.
    const imageClass = rawClass?.replace(' (best case)', '')

    // Matched, not stripped. `cell.replace('%', '')` removes only the FIRST occurrence,
    // which Semgrep's incomplete-sanitization rule flagged — and while this is parsing
    // rather than escaping, the rule is right about the behaviour: a cell with two `%`
    // would parse to a number built from text nobody intended. Anchoring the match means
    // anything that is not exactly a number, optionally followed by a percent sign, is
    // rejected rather than coerced into a plausible baseline.
    const NUMERIC_CELL = /^(-?\d+(?:\.\d+)?)(%?)$/
    const asNumber = (cell: string | undefined): number | null => {
      const matched = cell === undefined ? null : NUMERIC_CELL.exec(cell)
      if (matched === null) return null
      const parsed = Number.parseFloat(matched[1]!)
      if (Number.isNaN(parsed)) return null
      return matched[2] === '%' ? parsed / 100 : parsed
    }

    for (const [metric, cell] of [
      ['cer', cerCell],
      ['wer', werCell],
      ['songF1', f1Cell],
    ] as const) {
      const value = asNumber(cell)
      if (value !== null) previous.set(`${engine}/${imageClass}/${metric}`, value)
    }
  }
  return previous
}

/**
 * Metrics that got worse by more than {@link REGRESSION_EPSILON}.
 *
 * Direction is per metric and is the whole point: CER and WER going UP is worse, F1
 * going DOWN is worse. Treating them all the same way would report every genuine
 * improvement as a regression, which is how a check gets switched off.
 */
export function findRegressions(
  scores: readonly EngineScore[],
  previous: Map<string, number>,
): Regression[] {
  const regressions: Regression[] = []

  for (const score of scores) {
    for (const classScore of [...score.byClass, score.overall]) {
      const check = (metric: string, after: number, higherIsBetter: boolean): void => {
        const before = previous.get(`${score.engine}/${classScore.imageClass}/${metric}`)
        // No previous value is not a regression. A new engine or a new image class has
        // nothing to be worse than, and reporting it as a regression on its first run
        // would mean every addition arrives red.
        if (before === undefined) return
        const worse = higherIsBetter ? before - after : after - before
        if (worse > REGRESSION_EPSILON) {
          regressions.push({
            engine: score.engine,
            imageClass: classScore.imageClass,
            metric,
            before,
            after,
          })
        }
      }

      check('cer', classScore.cer, false)
      check('wer', classScore.wer, false)
      check('songF1', classScore.songF1, true)
    }
  }

  return regressions
}

export function toMarkdown(
  scores: readonly EngineScore[],
  regressions: readonly Regression[],
  generatedAt: string,
): string {
  const lines: string[] = [
    '# OCR evaluation',
    '',
    'GENERATED by `tools/ocr-eval` (M2-05a). Do not edit: the regression check parses',
    'this table, so a hand-edited number silently becomes the baseline.',
    '',
    `Generated: ${generatedAt}`,
    '',
    '**Song-level F1 is the headline metric. CER and WER are diagnostics**',
    '([ADR-015](../adr/0015-ocr-engine-decision-rule.md)). The product ships a list of',
    'songs, not characters, so an engine whose errors fall where the grammar does not look',
    'is the better engine here even with a worse CER. F1 runs the OCR output back through',
    '`packages/core`, which means it grades the engine AND the grammar together — the pair',
    'a user actually meets. CER and WER say *where* an engine fails, which is what you need',
    'to fix it; they do not decide anything on their own.',
    '',
    '**Handwriting is synthetic and is a best case.** The corpus draws it with webfonts: the',
    'same letter is the same shape every time, the baseline is straight, the stroke does not',
    'vary. Real handwriting is none of those. An engine that fails here will fail on real',
    'photographs; one that passes has cleared only the easy case. M2-06 brings the real set',
    'and M2-07 is the gate that counts.',
    '',
    '**Fallback %** is the share of images that would be sent to the server engine under',
    'FR-M-006 (confidence < 0.6) — a page falls back if its weakest item is below the',
    'threshold, or if nothing was extracted. This is a budget input, not a report line: it',
    'replaces the assumed 20% in `usage-model.yaml` and feeds the Lambda GB-s row of',
    '`make estimate`.',
    '',
    '**CER and WER are micro-averaged** — total errors over total reference units — so a',
    'twenty-line page weighs more than a one-line page, which is what "CER at most 5%',
    'printed" means. **F1 is macro-averaged**, because each document is one setlist and they',
    'count equally. Both are pinned to `jiwer` (ADR-014); whitespace and line breaks are',
    'collapsed first, since layout is not text.',
    '',
    '| Engine | Class | Images | Song F1 | Precision | Recall | Fallback % | CER | WER | Median | Empty |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ]

  for (const score of scores) {
    for (const classScore of score.byClass) lines.push(row(score.engine, classScore))
    lines.push(row(score.engine, score.overall))
  }

  const unmatched = scores.filter(score => score.unmatched.length > 0)
  if (unmatched.length > 0) {
    lines.push('', '## Unmatched images', '')
    lines.push(
      'An image in the corpus with no reading, or a reading for an image the corpus does',
      'not contain. Neither is scored: a collector that crashed halfway and an engine that',
      'is bad at handwriting need different responses, so they must not produce the same',
      'number.',
      '',
    )
    for (const score of unmatched) {
      lines.push(
        `- **${score.engine}**: ${score.unmatched.length} — ${score.unmatched.slice(0, 10).join(', ')}${score.unmatched.length > 10 ? ', …' : ''}`,
      )
    }
  }

  lines.push('', '## The ADR-015 verdict', '')
  const handwriting = scores
    .map(score => ({
      engine: score.engine,
      f1: score.byClass.find(c => c.imageClass === 'handwriting')?.songF1,
    }))
    .filter((entry): entry is { engine: string; f1: number } => entry.f1 !== undefined)

  if (handwriting.length === 0) {
    lines.push('No engine reported on handwriting, so the routing default is unchanged.')
  } else {
    const best = handwriting.reduce((a, b) => (b.f1 > a.f1 ? b : a))
    lines.push(
      `Best on-device handwriting F1: **${best.f1.toFixed(3)}** (${best.engine}), against the`,
      `${HANDWRITING_FLOOR} M3 floor.`,
      '',
    )
    lines.push(
      best.f1 < HANDWRITING_FLOOR
        ? `**Below the floor, so handwriting scans default to the server engine.** This is a ` +
            `routing default and not a verdict on the engine — print and screenshots stay ` +
            `on-device. Re-checked at M2-07 against the real set, where the number is expected ` +
            `to be worse: this column is a best case.`
        : `**At or above the floor, so the routing default is unchanged.** Clearing a best ` +
            `case is not evidence about the real one; M2-07 against the real set is what ` +
            `settles it.`,
    )
  }

  lines.push('', '## Regressions', '')
  if (regressions.length === 0) {
    lines.push(`No metric moved more than ${pct(REGRESSION_EPSILON)} the wrong way.`)
  } else {
    lines.push(`| Engine | Class | Metric | Before | After |`, `| --- | --- | --- | ---: | ---: |`)
    for (const regression of regressions) {
      lines.push(
        `| ${regression.engine} | ${regression.imageClass} | ${regression.metric} | ` +
          `${regression.before.toFixed(4)} | ${regression.after.toFixed(4)} |`,
      )
    }
  }

  return lines.join('\n')
}
