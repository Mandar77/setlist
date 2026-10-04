// The Chromium half of the OCR generator.
//
// Excluded from the root vitest config and run by `pnpm -C tools/golden-images
// test:render` in its own CI job, for the same reason as the CORE-06 conformance runner:
// `make verify` has a five-minute budget and must not need a browser.
//
// A handful of images, not 620. What is being checked is that the renderer produces a
// real JPEG at the right size, that the overflow guard actually fires, and that no
// document offers Chromium a fallback family to escape into. Rendering the whole corpus
// to assert those would be the same claims at sixty times the cost.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { chromium } from 'playwright'

import { loadSeed } from '@setlist/golden-gen'

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  documentFor,
  fillSheet,
  loadFont,
  openRenderer,
  planCorpus,
  plannedFontPackages,
  type Font,
  type ImageSpec,
  type Renderer,
} from '../src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const rows = loadSeed(resolve(repoRoot, 'golden', 'seed', 'recordings.jsonl'))
const fonts = new Map<string, Font>(plannedFontPackages().map(pkg => [pkg, loadFont(pkg)]))
const corpus = planCorpus(rows, fonts)

const fontFor = (spec: ImageSpec): Font => fonts.get(spec.fontPkg)!

/** One image of each class, so every code path through `documentFor` is drawn. */
const samples = ['handwriting', 'print', 'screenshot'].map(imageClass =>
  corpus.find(spec => spec.imageClass === imageClass)!,
)

let renderer: Renderer

beforeAll(async () => {
  renderer = await openRenderer()
}, 120_000)

afterAll(async () => {
  await renderer.close()
})

/** Width and height from a JPEG's first SOF marker. */
function jpegSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
  let offset = 2
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error(`not a marker at ${offset}`)
    const marker = bytes[offset + 1]!
    const length = bytes.readUInt16BE(offset + 2)
    // SOF0, SOF1, SOF2: baseline, extended and progressive. Not SOF4 (DHT) or SOF12.
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) }
    }
    offset += 2 + length
  }
  throw new Error('no SOF marker')
}

describe('rendering', () => {
  it('writes a JPEG at the planned size for every class', async () => {
    for (const spec of samples) {
      const image = await renderer.render(spec, fontFor(spec))
      expect(image.id).toBe(spec.id)
      expect(jpegSize(image.bytes), spec.id).toEqual({
        width: spec.widthPx,
        height: spec.heightPx,
      })
    }
  }, 120_000)

  it('compresses harder at a lower quality', async () => {
    // The JPEG-noise augmentation has to actually do something. Same document twice,
    // only the quality changed.
    const [spec] = samples
    const good = await renderer.render(
      { ...spec!, augmentation: { ...spec!.augmentation, jpegQuality: 95 } },
      fontFor(spec!),
    )
    const bad = await renderer.render(
      { ...spec!, augmentation: { ...spec!.augmentation, jpegQuality: 20 } },
      fontFor(spec!),
    )
    expect(bad.bytes.byteLength).toBeLessThan(good.bytes.byteLength)
  }, 120_000)

  it('is byte-identical on a rerun', async () => {
    // Determinism at the pixel level, which only holds for one platform and one browser
    // build — which is exactly why the images are rebuilt rather than committed, and why
    // the portable claim is about the manifest instead.
    const [spec] = samples
    const first = await renderer.render(spec!, fontFor(spec!))
    const second = await renderer.render(spec!, fontFor(spec!))
    expect(second.bytes.equals(first.bytes)).toBe(true)
  }, 120_000)
})

describe('the overflow guard', () => {
  it('refuses a document whose text does not fit', async () => {
    // The failing side, and the one that matters most. Text that overflows is text the
    // manifest claims and the image does not show; an earlier version of this generator
    // clipped silently and every one of those images was ground truth for characters no
    // engine could read.
    const spec = samples[0]!
    const overstuffed: ImageSpec = {
      ...spec,
      // Forty lines at the size chosen for a dozen cannot fit, and nothing else about
      // the document changes.
      lines: Array.from({ length: 40 }, (_unused, index) => ({
        text: `${index + 1}. A Reasonably Long Song Title - Some Artist Or Other`,
        struck: false,
        truth: { title: 'A Reasonably Long Song Title', artist: 'Some Artist Or Other' },
      })),
      fontSizePx: 52,
    }
    await expect(renderer.render(overstuffed, fontFor(spec))).rejects.toThrow(/overflows/)
  }, 120_000)

  it('accepts the documents the planner actually produced', async () => {
    // The passing side: the guard must not be so tight that real plan entries trip it.
    for (const spec of samples) {
      await expect(renderer.render(spec, fontFor(spec))).resolves.toBeDefined()
    }
  }, 120_000)
})

describe('the document', () => {
  it('names one font family and no fallback', () => {
    // A fallback would let Chromium quietly draw a missing glyph in a system font —
    // falsifying the manifest and putting unvetted glyphs in a published corpus. The
    // coverage rules make a miss impossible; this makes a miss visible if they are ever
    // wrong.
    for (const spec of samples) {
      const font = fontFor(spec)
      const html = documentFor(spec, font)
      expect(html).toContain(`font-family: '${font.family}';`)
      expect(html).not.toMatch(/font-family:[^;]*,/)
    }
  })

  it('embeds the font rather than linking to it', () => {
    for (const spec of samples) {
      const html = documentFor(spec, fontFor(spec))
      expect(html).toContain('src: url(data:font/woff2;base64,')
      expect(html).not.toContain('file://')
    }
  })

  it('carries no song text at all, because the text is set as text', () => {
    // The shell is markup; the lines are not. Semgrep blocked the hand-written HTML
    // escaper that used to put them here, and the fix was to stop building markup out of
    // untrusted strings rather than to build it more carefully.
    for (const spec of samples) {
      const html = documentFor(spec, fontFor(spec))
      for (const line of spec.lines) {
        expect(html, spec.id).not.toContain(line.text)
      }
      expect(html).toContain('<div class="scene"><div class="sheet"></div></div>')
    }
  })

  it('draws a title containing markup as that title, verbatim', async () => {
    // What `textContent` buys: a title is never parsed. The page gets its own browser so
    // the production renderer keeps no test-only seam.
    const spec = samples[0]!
    const awkward = '1. <script>alert(1)</script> & "Sons" — ½ <b>x</b>'
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.setViewportSize({ width: spec.widthPx, height: spec.heightPx })
      const probe: ImageSpec = {
        ...spec,
        lines: [{ text: awkward, struck: false, truth: null }],
      }
      await page.setContent(documentFor(probe, fontFor(spec)), { waitUntil: 'load' })
      await fillSheet(page, probe)

      const drawn = await page.evaluate(() =>
        [...document.querySelectorAll('.line')].map(element => element.textContent),
      )
      expect(drawn).toEqual([awkward])
      // And nothing was executed or injected on the way in.
      expect(await page.evaluate(() => document.querySelectorAll('script').length)).toBe(0)
      expect(await page.evaluate(() => document.querySelectorAll('.sheet b').length)).toBe(0)
    } finally {
      await browser.close()
    }
  }, 120_000)
})
