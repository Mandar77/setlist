/**
 * Grade one engine's output against the M2-01 corpus.
 *
 * ## The contract, and why there is one
 *
 * Four engines live in four runtimes — Apple Vision in Swift, ML Kit in Kotlin,
 * Tesseract.js in Node, RapidOCR in Python at M2-05b. None of them can share code with
 * this file, so what they share is a JSON shape: {@link EngineReading}, one per image,
 * lines in reading order. An engine that scored itself would produce a number
 * incomparable with the rest, which is the one thing this harness exists to prevent.
 *
 * ## Two truths, graded separately
 *
 * The corpus carries both on purpose (M2-01), because a struck-out line has two right
 * answers: OCR *should* read it, the extractor should *not* return it.
 *
 *   * **CER and WER** are graded against `line.text` — every line drawn on the page,
 *     struck ones included. An engine is not wrong for reading ink that is there.
 *   * **Song-level F1** is graded against `songTruth` — unstruck lines that carry a row.
 *     This runs the OCR text back through `packages/core`, so it measures the pair, not
 *     the engine alone. That is the number the product cares about: an engine with a
 *     worse CER that happens to fail on characters the grammar ignores is the better
 *     engine here, and only this metric can say so.
 */

import { extractDeterministic } from '@setlist/core'

import { cer, songF1, wer, type ErrorRate, type Prf } from './metrics.js'

/** What every engine hands back, whatever language it ran in. */
export interface EngineReading {
  readonly imageId: string
  /** Lines in reading order. Empty is a legitimate answer; absent is not. */
  readonly lines: readonly string[]
  /** Milliseconds for this image, when the collector measured it. */
  readonly ms?: number
}

/** One image's ground truth, read from the generated manifest. */
export interface TruthSpec {
  readonly id: string
  readonly imageClass: string
  readonly lines: readonly string[]
  readonly songTruth: readonly { readonly title: string; readonly artist: string }[]
}

export interface ImageScore {
  readonly imageId: string
  readonly imageClass: string
  readonly cer: ErrorRate
  readonly wer: ErrorRate
  readonly songs: Prf
  readonly ms: number | null
  /** True when the engine returned nothing for an image that has text. */
  readonly empty: boolean
  /** True when this page would have been sent to the server engine (FR-M-006). */
  readonly fallback: boolean
}

export interface ClassScore {
  readonly imageClass: string
  readonly images: number
  /**
   * Error rates are MICRO-averaged: total errors over total reference units, not the
   * mean of per-image rates.
   *
   * Macro-averaging lets a one-line image swing the number as hard as a twenty-line one,
   * and a single `Infinity` from a blank reference would poison the mean outright. Micro
   * is also what the M2 gate means by "CER at most 5% printed" — a property of the text,
   * not of the file list.
   */
  readonly cer: number
  readonly wer: number
  /** F1 is macro-averaged: each document is one setlist, and they count equally. */
  readonly songF1: number
  readonly precision: number
  readonly recall: number
  readonly medianMs: number | null
  readonly emptyImages: number
  /**
   * Share of images that would have gone to the server engine (FR-M-006).
   *
   * This is the number `usage-model.yaml`'s `server_ocr_page` volume is derived from, and
   * it was an assumed 20% until it was measured. It feeds the Lambda GB-s row of the
   * free-tier estimate, so it is a budget input rather than a report line.
   */
  readonly fallbackShare: number
}

export interface EngineScore {
  readonly engine: string
  readonly byClass: readonly ClassScore[]
  readonly overall: ClassScore
  /** Images the engine reported that the corpus does not contain, and vice versa. */
  readonly unmatched: readonly string[]
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

/**
 * Run the OCR lines back through the extractor.
 *
 * Joined with `\n` and handed over as raw text, exactly as a user's paste arrives, so
 * this measures the path the product actually runs. `sourceKind` is deliberately not
 * passed: the capture pipeline does not know whether a photographed page is a setlist or
 * a tracklist either, and telling the extractor would flatter the orientation ladder
 * (ADR-002) with information it will not have in production.
 */
function extractSongs(
  lines: readonly string[],
): { title: string; artist: string | null; confidence: number }[] {
  const result = extractDeterministic(lines.join('\n'))
  // `items` only. Anything ungrounded never reaches a user (ADR-007), so counting it
  // here would score the engine on output the product would refuse to show.
  return result.items.map(item => ({
    title: item.title,
    artist: item.artist,
    confidence: item.confidence,
  }))
}

/** FR-M-006: the server OCR fallback fires below this confidence. */
export const FALLBACK_CONFIDENCE = 0.6

/**
 * Would this image have been sent to the server engine?
 *
 * FR-M-006 states the threshold per scan, not per song, and a scan is the unit that can
 * actually be re-OCRed — you cannot re-read one line of a photograph. So the page falls
 * back if its WEAKEST item is below the threshold, or if nothing was extracted at all.
 *
 * That is the conservative reading, and conservative in the direction that matters: this
 * number replaces the assumed 20% fallback rate in `usage-model.yaml`, which feeds the
 * Lambda GB-s row of the free-tier estimate. Over-estimating server load makes the gate
 * harder to pass; under-estimating it is how the budget is blown by a forecast that was
 * comfortable. A mean would be the lenient reading and would quietly produce the nicer
 * number.
 *
 * An empty extraction counts as fallback rather than as "no songs, nothing to do":
 * from the product's side those are indistinguishable, and a page the on-device engine
 * could make nothing of is exactly the page the server exists for.
 */
export function needsFallback(items: readonly { readonly confidence: number }[]): boolean {
  if (items.length === 0) return true
  return items.some(item => item.confidence < FALLBACK_CONFIDENCE)
}

export function scoreImage(truth: TruthSpec, reading: EngineReading): ImageScore {
  const hasText = truth.lines.some(line => line.trim() !== '')
  const extracted = extractSongs(reading.lines)
  return {
    imageId: truth.id,
    imageClass: truth.imageClass,
    cer: cer(truth.lines, reading.lines),
    wer: wer(truth.lines, reading.lines),
    songs: songF1(truth.songTruth, extracted),
    ms: reading.ms ?? null,
    empty: hasText && reading.lines.every(line => line.trim() === ''),
    fallback: needsFallback(extracted),
  }
}

function aggregate(imageClass: string, scores: readonly ImageScore[]): ClassScore {
  const sum = (pick: (score: ImageScore) => number): number =>
    scores.reduce((total, score) => total + pick(score), 0)

  // Micro-average: the Infinity a blank reference produces lives in the per-image `rate`
  // and never reaches here, because this divides totals rather than averaging rates.
  const cerUnits = sum(s => s.cer.referenceUnits)
  const werUnits = sum(s => s.wer.referenceUnits)

  return {
    imageClass,
    images: scores.length,
    cer: cerUnits === 0 ? 0 : sum(s => s.cer.errors) / cerUnits,
    wer: werUnits === 0 ? 0 : sum(s => s.wer.errors) / werUnits,
    songF1: scores.length === 0 ? 0 : sum(s => s.songs.f1) / scores.length,
    precision: scores.length === 0 ? 0 : sum(s => s.songs.precision) / scores.length,
    recall: scores.length === 0 ? 0 : sum(s => s.songs.recall) / scores.length,
    medianMs: median(scores.map(s => s.ms).filter((ms): ms is number => ms !== null)),
    emptyImages: scores.filter(s => s.empty).length,
    fallbackShare: scores.length === 0 ? 0 : scores.filter(s => s.fallback).length / scores.length,
  }
}

export function scoreEngine(
  engine: string,
  truths: readonly TruthSpec[],
  readings: readonly EngineReading[],
): EngineScore {
  const byId = new Map(readings.map(reading => [reading.imageId, reading]))
  const scores: ImageScore[] = []
  const unmatched: string[] = []

  for (const truth of truths) {
    const reading = byId.get(truth.id)
    if (reading === undefined) {
      // A missing reading is NOT a zero score. Scoring it as total failure would let a
      // collector that crashed halfway look like an engine that is bad at handwriting,
      // and the two need different responses.
      unmatched.push(truth.id)
      continue
    }
    scores.push(scoreImage(truth, reading))
  }

  // The other direction too: an engine reporting an image the corpus does not contain
  // means the collector and the manifest disagree about what was rendered, and a report
  // built on that is measuring two different corpora.
  const truthIds = new Set(truths.map(truth => truth.id))
  for (const reading of readings) {
    if (!truthIds.has(reading.imageId)) unmatched.push(reading.imageId)
  }

  const classes = [...new Set(scores.map(score => score.imageClass))].sort()
  return {
    engine,
    byClass: classes.map(imageClass =>
      aggregate(
        imageClass,
        scores.filter(score => score.imageClass === imageClass),
      ),
    ),
    overall: aggregate('all', scores),
    unmatched: unmatched.sort(),
  }
}
