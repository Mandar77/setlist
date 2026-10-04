// The corpus plan: what M2-01 asks for, asserted against the plan rather than against a
// README.
//
// Everything here runs on the real seed and the installed fonts, because a plan test on
// a fixture would prove the planner works on a fixture. The expensive part — walking
// every codepoint of 2,242 rows against 14 fonts — is done once for the whole file.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { isUsable, loadSeed, truthFor } from '@setlist/golden-gen'

import {
  CLASS_COUNTS,
  IMAGE_CLASSES,
  MAX_CREDIT_CHARS,
  MAX_ROTATION_DEG,
  OCR_CORPUS_SEED,
  covers,
  fontFrom,
  fontSizeFor,
  lineHeightFor,
  loadFont,
  maxLinesFor,
  planCorpus,
  plannedFontPackages,
  songTruth,
  subsetsFor,
  usableHeight,
  WRAP_BUDGET_ROWS,
  type Font,
  type ImageSpec,
} from '../src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const rows = loadSeed(resolve(repoRoot, 'golden', 'seed', 'recordings.jsonl'))

const fonts = new Map<string, Font>(plannedFontPackages().map(pkg => [pkg, loadFont(pkg)]))
const corpus = planCorpus(rows, fonts)

/** Every (title, artist) pair the seed can legitimately produce. */
const seedTruths = new Set(
  rows.filter(isUsable).map(row => {
    const truth = truthFor(row)
    return JSON.stringify([truth.title, truth.artist])
  }),
)

describe('size and shape', () => {
  it('clears the floor of 600 images', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(600)
  })

  it('covers handwriting, print and screenshots', () => {
    for (const imageClass of IMAGE_CLASSES) {
      const count = corpus.filter(spec => spec.imageClass === imageClass).length
      expect(count, imageClass).toBe(CLASS_COUNTS[imageClass])
      expect(count, imageClass).toBeGreaterThan(0)
    }
  })

  it('gives every image a unique id', () => {
    expect(new Set(corpus.map(spec => spec.id)).size).toBe(corpus.length)
  })

  it('puts at least one song on every image', () => {
    for (const spec of corpus) {
      expect(spec.songTruth.length, spec.id).toBeGreaterThan(0)
    }
  })
})

describe('ground truth comes from the seed', () => {
  it('every line that carries a song carries one the seed knows', () => {
    // The CORE-03 rule, restated for images: an expectation the seed cannot produce was
    // invented by a renderer, and a corpus of invented expectations tests nothing.
    for (const spec of corpus) {
      for (const line of spec.lines) {
        if (line.truth === null) continue
        expect(
          seedTruths.has(JSON.stringify([line.truth.title, line.truth.artist])),
          line.text,
        ).toBe(true)
      }
    }
  })

  it('draws the title and the credit it claims', () => {
    for (const spec of corpus) {
      for (const line of spec.lines) {
        if (line.truth === null) continue
        // A renderer may only add — a marker, a separator. What it added is still around
        // the seed's own strings.
        expect(line.text, spec.id).toContain(line.truth.title)
        expect(line.text, spec.id).toContain(line.truth.artist)
      }
    }
  })

  it('excludes crossed-out songs from the song truth but keeps them on the page', () => {
    // Both halves of the two-truths rule. OCR must still read a struck line; the
    // extractor must not return it.
    const withStrikes = corpus.filter(spec => spec.lines.some(line => line.struck))
    expect(withStrikes.length).toBeGreaterThan(0)

    for (const spec of withStrikes) {
      const struck = spec.lines.filter(line => line.struck)
      for (const line of struck) {
        expect(line.text.length, spec.id).toBeGreaterThan(0)
        expect(spec.songTruth, spec.id).not.toContainEqual(line.truth)
      }
      expect(spec.songTruth.length).toBe(
        spec.lines.filter(line => !line.struck && line.truth !== null).length,
      )
    }
  })

  it('never counts a heading as a song', () => {
    const headed = corpus.filter(spec => spec.lines.some(line => line.truth === null))
    expect(headed.length).toBeGreaterThan(0)
    for (const spec of headed) {
      expect(spec.songTruth.length).toBeLessThan(spec.lines.length)
    }
  })

  it('agrees with songTruth computed from the lines', () => {
    for (const spec of corpus) {
      expect(spec.songTruth, spec.id).toEqual(songTruth(spec.lines))
    }
  })
})

describe('every character is drawable by the font that draws it', () => {
  it('no image asks a font for a glyph it does not have', () => {
    // The guarantee that keeps Chromium from substituting a system font: a silent
    // fallback would both falsify the manifest and put unvetted glyphs in the corpus.
    for (const spec of corpus) {
      const font = fonts.get(spec.fontPkg)!
      const text = spec.lines.map(line => line.text).join('\n')
      expect(covers(font, text), `${spec.id} (${spec.fontPkg})`).toBe(true)
    }
  })

  it('lists exactly the subsets its text needs', () => {
    for (const spec of corpus) {
      const font = fonts.get(spec.fontPkg)!
      const text = spec.lines.map(line => line.text).join('\n')
      expect(spec.subsets, spec.id).toEqual(subsetsFor(font, text))
    }
  })

  it('refuses to plan at all when a font can draw nothing', () => {
    // The failing side. A font set that covers no row must stop the run rather than
    // produce a corpus of empty pages.
    const blind = new Map(
      plannedFontPackages().map(pkg => [
        pkg,
        fontFrom(
          pkg,
          {
            id: 'blind',
            family: 'Blind',
            category: 'handwriting',
            subsets: ['latin'],
            weights: [400],
            license: { type: 'OFL-1.1', attribution: 'c' },
          },
          // A range holding one codepoint no title uses.
          { latin: 'U+E000' },
        ),
      ]),
    )
    expect(() => planCorpus(rows, blind)).toThrow(/can draw no row/)
  })
})

describe('augmentations', () => {
  const has = (predicate: (spec: ImageSpec) => boolean): number => corpus.filter(predicate).length

  it('never rotates further than M2-01 allows', () => {
    for (const spec of corpus) {
      expect(Math.abs(spec.augmentation.rotationDeg), spec.id).toBeLessThanOrEqual(MAX_ROTATION_DEG)
    }
  })

  it('applies every augmentation the task names', () => {
    // Named one by one rather than as a count, so dropping one is a failing test with
    // the right name on it instead of a number that still looks plausible.
    expect(has(spec => spec.augmentation.rotationDeg !== 0)).toBeGreaterThan(0)
    expect(has(spec => spec.augmentation.perspectiveDeg !== 0)).toBeGreaterThan(0)
    expect(has(spec => spec.augmentation.blurPx > 0)).toBeGreaterThan(0)
    expect(has(spec => spec.augmentation.glare !== null)).toBeGreaterThan(0)
    expect(has(spec => spec.augmentation.jpegQuality < 100)).toBeGreaterThan(0)
    expect(has(spec => spec.augmentation.ruledPaper)).toBeGreaterThan(0)
    expect(has(spec => spec.lines.some(line => line.struck))).toBeGreaterThan(0)
  })

  it('leaves some images undistorted, so the set is not uniformly hard', () => {
    expect(
      has(
        spec =>
          spec.augmentation.rotationDeg === 0 &&
          spec.augmentation.perspectiveDeg === 0 &&
          spec.augmentation.blurPx === 0 &&
          spec.augmentation.glare === null,
      ),
    ).toBeGreaterThan(0)
  })

  it('keeps camera artefacts out of screenshots', () => {
    // A framebuffer copy has no rotation, no tilt, no reflection and no paper. Grading
    // OCR on a distortion the product can never receive makes the number mean less.
    for (const spec of corpus.filter(s => s.imageClass === 'screenshot')) {
      expect(spec.augmentation.rotationDeg, spec.id).toBe(0)
      expect(spec.augmentation.perspectiveDeg, spec.id).toBe(0)
      expect(spec.augmentation.glare, spec.id).toBeNull()
      expect(spec.augmentation.ruledPaper, spec.id).toBe(false)
    }
  })

  it('keeps JPEG quality in range', () => {
    for (const spec of corpus) {
      expect(spec.augmentation.jpegQuality, spec.id).toBeGreaterThanOrEqual(1)
      expect(spec.augmentation.jpegQuality, spec.id).toBeLessThanOrEqual(100)
    }
  })
})

describe('the text fits the page', () => {
  it('reserves room for every line to wrap once', () => {
    for (const spec of corpus) {
      // Computed with the generator's own helpers, so this asserts the budget holds
      // rather than asserting a second copy of the arithmetic agrees with the first.
      const usable = usableHeight(spec.imageClass, spec.heightPx)
      const worstCase = spec.lines.length * WRAP_BUDGET_ROWS * lineHeightFor(spec.fontSizePx)
      expect(worstCase, spec.id).toBeLessThanOrEqual(usable)
    }
  })

  it('caps how long a credit may be', () => {
    for (const spec of corpus) {
      for (const line of spec.lines) {
        if (line.truth === null) continue
        expect(line.truth.title.length + line.truth.artist.length, line.text).toBeLessThanOrEqual(
          MAX_CREDIT_CHARS,
        )
      }
    }
  })

  it('shrinks the font as the line count grows rather than overflowing', () => {
    expect(fontSizeFor('handwriting', 1632, 14, [28, 52])).toBeLessThan(
      fontSizeFor('handwriting', 1632, 6, [28, 52]),
    )
  })

  it('never returns a size below the class minimum', () => {
    expect(fontSizeFor('handwriting', 1632, 999, [28, 52])).toBe(28)
    // Which is exactly why the line count is capped first.
    expect(maxLinesFor('handwriting', 1632, 28)).toBeLessThan(999)
  })
})

describe('determinism', () => {
  it('produces the same corpus from the same seed', () => {
    expect(planCorpus(rows, fonts, 4242)).toEqual(planCorpus(rows, fonts, 4242))
  })

  it('produces a different corpus from a different seed', () => {
    // Without this, the assertion above would also hold for a planner that ignored its
    // seed entirely.
    expect(planCorpus(rows, fonts, 4242)).not.toEqual(planCorpus(rows, fonts, 4243))
  })

  it('uses no clock and no filesystem order', () => {
    // Re-reading the seed from disk is the same read, and re-planning is the same plan.
    const reread = loadSeed(resolve(repoRoot, 'golden', 'seed', 'recordings.jsonl'))
    expect(planCorpus(reread, fonts, OCR_CORPUS_SEED)).toEqual(corpus)
  })
})

describe('the committed summary', () => {
  const summary = JSON.parse(
    readFileSync(resolve(repoRoot, 'golden', 'ocr', 'corpus.json'), 'utf8'),
  ) as {
    counts: Record<string, number>
    maxRotationDeg: number
    augmentations: Record<string, number>
    fonts: { licence: string; attribution: string }[]
  }

  it('records the counts M2-01 asks for', () => {
    expect(summary.counts['total']).toBeGreaterThanOrEqual(600)
    for (const imageClass of IMAGE_CLASSES) {
      expect(summary.counts[imageClass], imageClass).toBeGreaterThan(0)
    }
  })

  it('records a licence for every font and no contact address', () => {
    expect(summary.fonts.length).toBeGreaterThanOrEqual(10)
    for (const font of summary.fonts) {
      expect(['OFL-1.1', 'Apache-2.0']).toContain(font.licence)
      expect(font.attribution).not.toMatch(/@/)
    }
  })

  it('records the rotation ceiling and stays under it', () => {
    expect(summary.maxRotationDeg).toBe(MAX_ROTATION_DEG)
    expect(summary.augmentations['maxAbsRotationDeg']).toBeLessThanOrEqual(MAX_ROTATION_DEG)
  })
})
