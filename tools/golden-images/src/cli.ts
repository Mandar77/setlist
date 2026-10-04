/**
 * `make golden` builds the OCR corpus; `make golden-check` asserts it is current.
 *
 * The asymmetry between the two is the point. `--check` rebuilds the plan and compares
 * the committed summary byte for byte — pure, portable and fast enough to live in
 * `make verify`, which has a five-minute budget and no browser. The full run also writes
 * the manifest and renders the images into `golden/ocr-generated/`, which is git-ignored:
 * M2-01 says the images are generated in CI and never committed.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isUsable, loadSeed, truthFor } from '@setlist/golden-gen'

import { loadFont, type Font } from './fonts.js'
import { buildManifest, buildSummary, serialize, serializeSummary } from './manifest.js'
import { planCorpus, plannedFontPackages, type ImageSpec } from './plan.js'
import { fileNameFor, openRenderer } from './render.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')

export const SEED_PATH = resolve(repoRoot, 'golden', 'seed', 'recordings.jsonl')
/** Committed: counts, licences, coverage and the manifest digest. */
export const SUMMARY_PATH = resolve(repoRoot, 'golden', 'ocr', 'corpus.json')
/** Git-ignored: the full manifest and the images themselves. */
export const GENERATED_DIR = resolve(repoRoot, 'golden', 'ocr-generated')

interface Built {
  readonly specs: readonly ImageSpec[]
  readonly fonts: Map<string, Font>
  readonly manifestText: string
  readonly summaryText: string
}

function build(): Built {
  const rows = loadSeed(SEED_PATH)
  const fonts = new Map(plannedFontPackages().map(pkg => [pkg, loadFont(pkg)]))
  const specs = planCorpus(rows, fonts)
  const manifest = buildManifest(specs)
  const seedTexts = rows.filter(isUsable).map(row => `${row.title} ${truthFor(row).artist}`)
  const summary = buildSummary(manifest, [...fonts.values()], seedTexts)
  return {
    specs,
    fonts,
    manifestText: serialize(manifest),
    summaryText: serializeSummary(summary),
  }
}

async function renderAll(built: Built): Promise<number> {
  // Cleared rather than overwritten. A renamed or shrunk corpus would otherwise leave
  // last run's images behind, and a harness globbing the directory would quietly score a
  // mixture of two corpora.
  rmSync(GENERATED_DIR, { recursive: true, force: true })
  mkdirSync(GENERATED_DIR, { recursive: true })
  writeFileSync(join(GENERATED_DIR, 'manifest.json'), built.manifestText, 'utf8')

  const renderer = await openRenderer()
  try {
    let done = 0
    for (const spec of built.specs) {
      const font = built.fonts.get(spec.fontPkg)
      if (font === undefined) throw new Error(`${spec.id}: no font loaded for ${spec.fontPkg}`)
      const image = await renderer.render(spec, font)
      writeFileSync(join(GENERATED_DIR, fileNameFor(spec)), image.bytes)
      done += 1
      if (done % 50 === 0) console.log(`golden-images: ${done}/${built.specs.length}`)
    }
    return done
  } finally {
    await renderer.close()
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const built = build()

  if (argv.includes('--check')) {
    let actual: string
    try {
      actual = readFileSync(SUMMARY_PATH, 'utf8')
    } catch {
      console.error('golden-images: golden/ocr/corpus.json is missing — run `make golden`')
      return 1
    }
    if (actual !== built.summaryText) {
      console.error(
        'golden-images: golden/ocr/corpus.json does not match the generator. Either it ' +
          'was edited by hand, or the generator, the seed or a font package changed and ' +
          'it was not regenerated. Run `make golden`.',
      )
      return 1
    }
    const summary = JSON.parse(actual) as { counts: Record<string, number> }
    console.log(
      `golden-images: corpus current — ${summary.counts['total']} images ` +
        `(${summary.counts['handwriting']} handwriting, ${summary.counts['print']} print, ` +
        `${summary.counts['screenshot']} screenshot)`,
    )
    return 0
  }

  mkdirSync(dirname(SUMMARY_PATH), { recursive: true })
  writeFileSync(SUMMARY_PATH, built.summaryText, 'utf8')

  if (argv.includes('--manifest-only')) {
    mkdirSync(GENERATED_DIR, { recursive: true })
    writeFileSync(join(GENERATED_DIR, 'manifest.json'), built.manifestText, 'utf8')
    console.log('golden-images: wrote the summary and the manifest; no images requested')
    return 0
  }

  const written = await renderAll(built)
  const onDisk = readdirSync(GENERATED_DIR).filter(name => name.endsWith('.jpg')).length
  if (written !== built.specs.length || onDisk !== built.specs.length) {
    console.error(
      `golden-images: rendered ${written} and found ${onDisk} on disk, ` +
        `expected ${built.specs.length}`,
    )
    return 1
  }
  console.log(`golden-images: rendered ${written} images into golden/ocr-generated/`)
  return 0
}

process.exitCode = await main(process.argv.slice(2))
