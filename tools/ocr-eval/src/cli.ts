#!/usr/bin/env node
/**
 * Grade every engine that reported, and write the report.
 *
 *   node --import tsx src/cli.ts --manifest <path> --readings <dir> --out docs/reports/ocr-eval.md
 *
 * Exits non-zero when a metric regressed against the committed report. That exit code is
 * what makes this a gate rather than a nightly reading nobody diffs (M2-05a).
 *
 * Readings are one JSON file per engine, named `<engine>.json`, each an array of
 * {@link EngineReading}. Four engines run in four languages and none of them can share
 * code with this; a directory of JSON is the whole contract between them.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { scoreEngine, type EngineReading, type EngineScore, type TruthSpec } from './evaluate.js'
import { findRegressions, parsePrevious, toMarkdown } from './report.js'

interface Args {
  manifest: string
  readings: string
  out: string | undefined
}

function parseArgs(argv: readonly string[]): Args {
  let manifest = 'golden/ocr-generated/manifest.json'
  let readings = 'golden/ocr-generated/readings'
  let out: string | undefined

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--manifest' || flag === '--readings' || flag === '--out') {
      if (value === undefined) throw new Error(`${flag} needs a value`)
      if (flag === '--manifest') manifest = value
      else if (flag === '--readings') readings = value
      else out = value
      i += 1
    } else if (flag !== undefined) {
      throw new Error(`unknown argument '${flag}'`)
    }
  }
  return { manifest, readings, out }
}

/** Ground truth, read from the generated manifest rather than re-derived. */
function truthsFrom(manifestPath: string): TruthSpec[] {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  return (manifest.images ?? []).map(
    (image: {
      id: string
      imageClass: string
      lines: { text: string }[]
      songTruth: { title: string; artist: string }[]
    }): TruthSpec => ({
      id: image.id,
      imageClass: image.imageClass,
      // `line.text` — every line DRAWN on the page, struck ones included. OCR should read
      // ink that is on the paper; it is the extractor that must not return it, and that
      // is what `songTruth` grades.
      lines: image.lines.map(line => line.text),
      songTruth: image.songTruth,
    }),
  )
}

let args: Args
try {
  args = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(`ocr-eval: ${(error as Error).message}`)
  process.exit(2)
}

if (!existsSync(args.manifest)) {
  console.error(
    `ocr-eval: no manifest at ${args.manifest}. The corpus is generated, never committed ` +
      '(M2-01) — run `make golden` first.',
  )
  process.exit(2)
}

const truths = truthsFrom(args.manifest)

const readingFiles = existsSync(args.readings)
  ? readdirSync(args.readings)
      .filter(name => name.endsWith('.json'))
      .sort()
  : []

if (readingFiles.length === 0) {
  // Not a pass. A report with no engines in it would be written, committed, and read as
  // "nothing regressed".
  console.error(
    `ocr-eval: no engine readings in ${args.readings}. Each engine writes ` +
      '<engine>.json there; a report with no engines is not a passing report.',
  )
  process.exit(2)
}

const scores: EngineScore[] = readingFiles.map(name => {
  const readings: EngineReading[] = JSON.parse(readFileSync(join(args.readings, name), 'utf8'))
  return scoreEngine(basename(name, '.json'), truths, readings)
})

const outPath = args.out ?? 'docs/reports/ocr-eval.md'
const previous = existsSync(outPath) ? parsePrevious(readFileSync(outPath, 'utf8')) : new Map()
const regressions = findRegressions(scores, previous)

// A fixed date would make every run's diff empty; the real one makes it one line.
const markdown = toMarkdown(scores, regressions, new Date().toISOString().slice(0, 10))
writeFileSync(outPath, `${markdown}\n`, { encoding: 'utf8' })
console.log(markdown)
console.log(`\nwritten to ${outPath}`)

if (regressions.length > 0) {
  console.error(
    `\nocr-eval: ${regressions.length} metric(s) regressed against the committed report.`,
  )
  process.exit(1)
}

console.log(`\nocr-eval: ${scores.length} engine(s), no regression`)
