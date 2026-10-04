/**
 * CER, WER and song-level F1.
 *
 * These are the numbers M2's exit gate is written in terms of — "CER at most 5% printed,
 * at most 20% handwriting" — so the arithmetic here decides whether a milestone passes.
 * That is also why it is pinned to an oracle rather than trusted
 * ([ADR-014](../../../docs/adr/0014-ocr-metrics-oracle.md)): every definition below is a
 * judgement call that returns a plausible number when it is wrong, never an error.
 *
 * The three that actually bite:
 *
 *   * **The denominator is the REFERENCE length, not the alignment length.** Dividing by
 *     the alignment makes a wildly over-long hypothesis score better than a short one,
 *     because padding the alignment grows the denominator faster than the errors.
 *   * **An empty reference is not a free pass.** Zero reference characters with a
 *     non-empty hypothesis is infinite error, not 0/0. Returning 0 there would make an
 *     engine that hallucinates on a blank page the best-scoring engine in the table.
 *   * **Words split on whitespace after collapsing runs**, so a double space is not a
 *     word. `jiwer` does this and a naive `split(' ')` does not.
 */

/**
 * Levenshtein distance, iterative with two rows.
 *
 * Two rows rather than a full matrix because the corpus is 620 images of up to ~20 lines
 * and the full matrix is only needed to recover the alignment, which nothing here wants.
 */
export function editDistance(reference: readonly string[], hypothesis: readonly string[]): number {
  if (reference.length === 0) return hypothesis.length
  if (hypothesis.length === 0) return reference.length

  let previous = Array.from({ length: reference.length + 1 }, (_, i) => i)
  let current = new Array<number>(reference.length + 1).fill(0)

  for (let h = 1; h <= hypothesis.length; h += 1) {
    current[0] = h
    for (let r = 1; r <= reference.length; r += 1) {
      const substitution = previous[r - 1]! + (reference[r - 1] === hypothesis[h - 1] ? 0 : 1)
      const insertion = previous[r]! + 1
      const deletion = current[r - 1]! + 1
      current[r] = Math.min(substitution, insertion, deletion)
    }
    const swap = previous
    previous = current
    current = swap
  }

  return previous[reference.length]!
}

/**
 * All whitespace to one space, then strip.
 *
 * This is the transform the oracle applies (`oracle-py/metrics.py`), and it is a reviewed
 * decision rather than jiwer's default — which was wrong here in two ways that only
 * running it revealed. jiwer's own word splitter splits on **spaces, not newlines**, so
 * `'line one\nline two'` is three words and an engine that merged every line would be
 * rewarded for it; and its CER strips the ends of a string but leaves internal whitespace
 * runs, charging an error for every extra space an engine emits.
 *
 * Neither is what M2 grades. Line breaking and spacing are layout, not text: an engine
 * that reads every character correctly and wraps differently has made no reading error.
 */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/** Words: whitespace-separated after {@link collapseWhitespace}, newlines included. */
export function words(text: string): string[] {
  const collapsed = collapseWhitespace(text)
  return collapsed === '' ? [] : collapsed.split(' ')
}

/** Characters as code POINTS, so an emoji or a CJK character is one unit, not two. */
export function characters(text: string): string[] {
  return [...collapseWhitespace(text)]
}

export interface ErrorRate {
  /** `errors / max(referenceUnits, 1)`. See {@link rateOf} for the guarded denominator. */
  readonly rate: number
  readonly errors: number
  readonly referenceUnits: number
}

function rateOf(reference: readonly string[], hypothesis: readonly string[]): ErrorRate {
  const errors = editDistance(reference, hypothesis)
  // The denominator is guarded at 1 rather than being zero, which is what jiwer does and
  // what the differential pins. An empty reference with output scores as the full error
  // count — 13 characters of invention on a blank page is 1300%, which is maximally wrong
  // and still a finite number the micro-average can add up. `Infinity` would be the other
  // honest answer and is useless downstream; scoring it 0 would be the comfortable lie,
  // making an engine that hallucinates onto a blank page the best in the table.
  const referenceUnits = reference.length
  return { rate: errors / Math.max(referenceUnits, 1), errors, referenceUnits }
}

/**
 * Character error rate over a whole document.
 *
 * Lines are joined with `\n` rather than scored individually and averaged. Averaging
 * per-line rates weights a three-character line the same as a sixty-character one, and
 * it needs the engine's lines to correspond one-to-one with the reference's — which is
 * exactly what an engine that merges or splits lines gets wrong, so the metric would
 * stop measuring the failure it most needs to catch.
 */
export function cer(
  referenceLines: readonly string[],
  hypothesisLines: readonly string[],
): ErrorRate {
  return rateOf(characters(referenceLines.join('\n')), characters(hypothesisLines.join('\n')))
}

/** Word error rate, same joining rule as {@link cer}. */
export function wer(
  referenceLines: readonly string[],
  hypothesisLines: readonly string[],
): ErrorRate {
  return rateOf(words(referenceLines.join('\n')), words(hypothesisLines.join('\n')))
}

export interface Prf {
  readonly precision: number
  readonly recall: number
  readonly f1: number
  readonly truePositives: number
  readonly falsePositives: number
  readonly falseNegatives: number
}

/**
 * Song-level precision, recall and F1 as a MULTISET comparison.
 *
 * A set would be wrong: a setlist can legitimately repeat a song, and collapsing
 * duplicates would hide an engine that emitted the same line twice — which is a real and
 * common OCR failure on ruled paper.
 *
 * Matching is on the normalized `title` + SEPARATOR + `artist` pair, and the separator
 * is not decoration: a plain join on `-` collides with the many titles that contain a
 * dash, which is the whole reason the orientation problem exists in this project. A
 * space would be worse still — it would make ("Hello World", "") and ("Hello", "World")
 * the same song.
 */

/**
 * U+0000, built rather than written as an escape.
 *
 * A `\u0000` escape in this file is a literal NUL BYTE in the committed source the
 * moment any tool normalizes it, which has already happened twice in this repository
 * — an unreviewable control character sitting in a tracked file. `String.fromCharCode`
 * produces the same value at runtime and leaves the source readable.
 */
const SEPARATOR = String.fromCharCode(0)

export function songF1(
  expected: readonly { readonly title: string; readonly artist: string | null }[],
  actual: readonly { readonly title: string; readonly artist: string | null }[],
): Prf {
  const key = (song: { title: string; artist: string | null }): string =>
    song.title.trim().toLowerCase() + SEPARATOR + (song.artist ?? '').trim().toLowerCase()

  const remaining = new Map<string, number>()
  for (const song of expected) {
    remaining.set(key(song), (remaining.get(key(song)) ?? 0) + 1)
  }

  let truePositives = 0
  for (const song of actual) {
    const left = remaining.get(key(song)) ?? 0
    if (left > 0) {
      truePositives += 1
      remaining.set(key(song), left - 1)
    }
  }

  const falsePositives = actual.length - truePositives
  const falseNegatives = expected.length - truePositives

  // Both conventions matter at the edges. No expected and no actual is a perfect score,
  // because the extractor correctly returned nothing for a page of headings; no expected
  // with some actual is zero, not undefined.
  const precision =
    actual.length === 0 ? (expected.length === 0 ? 1 : 0) : truePositives / actual.length
  const recall =
    expected.length === 0 ? (actual.length === 0 ? 1 : 0) : truePositives / expected.length
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)

  return { precision, recall, f1, truePositives, falsePositives, falseNegatives }
}
