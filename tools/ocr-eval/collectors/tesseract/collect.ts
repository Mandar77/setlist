#!/usr/bin/env node
/**
 * The Tesseract.js collector: run the PWA's engine over the golden corpus.
 *
 *   node --import tsx collectors/tesseract/collect.ts            # the whole corpus
 *   node --import tsx collectors/tesseract/collect.ts --limit 12 # a smoke run
 *
 * Writes `golden/ocr-generated/readings/tesseract.json` — an array of
 * `{ imageId, lines, ms }`, which is the only contract the harness has with any engine
 * (ADR-014). It does no scoring: four engines in four languages, one scorer, or the
 * numbers are not comparable.
 *
 * ## Why this engine matters more than it looks
 *
 * Tesseract.js is the PWA's engine, and as of 2026-10-07 it is also what **iPhone users
 * get**: at $0 there is no native iOS app beyond the owner's sideload, so Apple Vision is
 * deferred to M2-08 and the web path covers iOS. This is not the weakest-platform
 * fallback; for a whole platform it is the product.
 *
 * ## The language data is a dependency, not a download
 *
 * Tesseract.js fetches `eng.traineddata` from a CDN by default. That would be an
 * unpinned, unchecksummed download inside a CI job on every run — the thing this
 * repository pins the Maestro binary and every action SHA to avoid. `@tesseract.js-data/eng`
 * is the same file as an npm package, so the lockfile and the seven-day
 * `minimumReleaseAge` cover it like everything else, and `langPath` points at
 * `node_modules`. Nothing reaches the network while this runs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { availableParallelism } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createWorker } from 'tesseract.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..', '..')
const generatedDir = join(repoRoot, 'golden', 'ocr-generated')
const readingsDir = join(generatedDir, 'readings')

/**
 * Which trained model, and where it sits.
 *
 * `@tesseract.js-data/eng` ships two: `4.0.0`, the standard model, and `4.0.0_best_int`,
 * the larger and more accurate LSTM quantized to integers. The choice moves every number
 * in the report, so it is stated here rather than defaulted into.
 *
 * **Standard**, because the PWA is the thing being measured. The model is downloaded to
 * the device — and since Apple Vision was deferred to M2-08, that device is every iPhone
 * as well as every desktop browser. Grading a model the PWA would not ship because of its
 * size would produce a number the product could never reproduce, which is the same class
 * of mistake as grading an engine on ground truth that was clipped off the page.
 *
 * `_best_int` is the lever to pull if the standard model lands just under the ADR-015
 * floor: a size-for-accuracy trade, argued with these numbers in hand.
 */
const MODEL = '4.0.0'

function langPath(): string {
  const require = createRequire(import.meta.url)
  // Resolve the package's own manifest and walk from there: hard-coding a path inside
  // node_modules breaks silently on the next version, and pnpm's layout is not flat.
  return join(dirname(require.resolve('@tesseract.js-data/eng/package.json')), MODEL)
}

interface Reading {
  readonly imageId: string
  readonly lines: readonly string[]
  readonly ms: number
}

interface Args {
  limit: number | undefined
  concurrency: number
}

function parseArgs(argv: readonly string[]): Args {
  let limit: number | undefined
  // One worker per core, capped: each worker loads its own copy of the WASM core and the
  // traineddata, so memory grows with concurrency and a GitHub runner has 7GB.
  let concurrency = Math.max(1, Math.min(4, availableParallelism() - 1))

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--limit' || flag === '--concurrency') {
      if (value === undefined) throw new Error(`${flag} needs a value`)
      const parsed = Number.parseInt(value, 10)
      if (!Number.isFinite(parsed) || parsed < 1)
        throw new Error(`${flag} must be a positive integer`)
      if (flag === '--limit') limit = parsed
      else concurrency = parsed
      i += 1
    } else if (flag !== undefined) {
      throw new Error(`unknown argument '${flag}'`)
    }
  }
  return { limit, concurrency }
}

const args = parseArgs(process.argv.slice(2))

const manifestPath = join(generatedDir, 'manifest.json')
if (!existsSync(manifestPath)) {
  console.error(
    `tesseract: no manifest at ${manifestPath}. The corpus is generated, never committed ` +
      '(M2-01) — run `make golden` first.',
  )
  process.exit(2)
}

const manifest: { images: { id: string }[] } = JSON.parse(readFileSync(manifestPath, 'utf8'))
const ids = manifest.images.map(image => image.id).slice(0, args.limit)

if (ids.length === 0) {
  console.error('tesseract: the manifest lists no images')
  process.exit(2)
}

console.log(
  `tesseract: ${ids.length} image(s), ${args.concurrency} worker(s), lang data from ${langPath()}`,
)

/**
 * One worker's share of the corpus.
 *
 * Each worker is created once and reused: `createWorker` loads the WASM core and the
 * traineddata, which costs seconds, and paying that 620 times would make the job's
 * runtime a measurement of startup rather than of OCR.
 */
async function runShard(shard: readonly string[], index: number): Promise<Reading[]> {
  const worker = await createWorker('eng', undefined, {
    langPath: langPath(),
    // Silent: the default logger prints a progress line per image per worker, which on
    // 620 images buries anything worth reading.
    logger: () => {},
  })

  const readings: Reading[] = []
  try {
    for (const [position, id] of shard.entries()) {
      const started = performance.now()
      const { data } = await worker.recognize(join(generatedDir, `${id}.jpg`))
      const ms = performance.now() - started

      // Split on newlines rather than reading `data.blocks`. The contract is lines in
      // reading order, and `text` is what the PWA would actually hand the extractor —
      // taking a richer structure here would measure a code path the product does not use.
      const lines = data.text
        .split('\n')
        .map(line => line.trim())
        .filter(line => line !== '')

      readings.push({ imageId: id, lines, ms })
      if (index === 0 && position > 0 && position % 25 === 0) {
        console.log(`tesseract: worker 0 at ${position}/${shard.length}`)
      }
    }
  } finally {
    // Terminated even on failure: a leaked worker holds a WASM heap and the process never
    // exits, which in CI is a job that hangs until the runner's timeout rather than one
    // that fails with a readable error.
    await worker.terminate()
  }
  return readings
}

const shards: string[][] = Array.from({ length: args.concurrency }, () => [])
// Round-robin rather than contiguous blocks: the corpus is ordered by class, so
// contiguous shards would give one worker every handwriting image and another every
// screenshot, and the slowest class would decide the wall-clock time.
ids.forEach((id, index) => shards[index % args.concurrency]!.push(id))

const started = performance.now()
const results = await Promise.all(shards.map((shard, index) => runShard(shard, index)))
const elapsed = (performance.now() - started) / 1000

// Sorted by id so the artifact is stable: an unsorted file would diff on worker
// scheduling, which has nothing to do with what the engine read.
const readings = results.flat().sort((a, b) => a.imageId.localeCompare(b.imageId))

mkdirSync(readingsDir, { recursive: true })
writeFileSync(join(readingsDir, 'tesseract.json'), `${JSON.stringify(readings, null, 2)}\n`, 'utf8')

const empty = readings.filter(reading => reading.lines.length === 0).length
console.log(
  `tesseract: ${readings.length} image(s) in ${elapsed.toFixed(1)}s, ` +
    `${empty} returned nothing — written to golden/ocr-generated/readings/tesseract.json`,
)
