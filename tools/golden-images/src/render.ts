/**
 * Turning a plan entry into a JPEG, in Chromium.
 *
 * ## Why a browser
 *
 * The alternatives were a native image library — which means a build toolchain, a
 * platform binary per OS and a postinstall script this repository blocks on purpose — or
 * writing a glyph rasterizer. The second is the worse idea: an OCR accuracy gate built
 * on a hand-rolled rasterizer measures the rasterizer's quirks as much as the engine's,
 * and nothing would tell you which.
 *
 * Chromium is already here. `packages/core` pins Playwright for the CORE-06 conformance
 * run and CI already installs the browser, so this adds a use rather than a dependency.
 * It also happens to be the most honest way to produce the screenshot class: a screenshot
 * of a list is what a browser makes when you ask it for one.
 *
 * ## Fonts arrive as bytes, not as paths
 *
 * Every face is embedded as a `data:` URI. Not for tidiness — this repository lives under
 * a directory with a space in its name, and the last thing that resolved a file path into
 * a `file://` URL here silently failed to find it. Bytes in the document have no path to
 * get wrong.
 *
 * The `unicode-range` on each `@font-face` is the font's own, so Chromium picks the
 * subset file that actually holds the glyph. The planner has already guaranteed every
 * character is covered, which is what keeps Chromium from quietly substituting a system
 * font — a substitution that would both falsify the manifest and put unvetted glyphs in
 * a published corpus.
 */

import { chromium, type Browser, type Page } from 'playwright'

import { subsetFile, type Font } from './fonts.js'
import {
  lineHeightFor,
  paddingFor,
  sheetFractionFor,
  type Augmentation,
  type ImageSpec,
  type PlannedLine,
} from './plan.js'

/** The `@font-face` rules for exactly the subsets this document needs. */
function fontFaces(font: Font, spec: ImageSpec): string {
  return spec.subsets
    .map(name => {
      const subset = font.subsets.find(candidate => candidate.name === name)
      if (subset === undefined) throw new Error(`${font.pkg}: no subset ${name}`)
      const bytes = subsetFile(font, name, spec.weight).toString('base64')
      return [
        '@font-face {',
        `  font-family: '${font.family}';`,
        '  font-style: normal;',
        `  font-weight: ${spec.weight};`,
        `  src: url(data:font/woff2;base64,${bytes}) format('woff2');`,
        `  unicode-range: ${subset.range};`,
        '}',
      ].join('\n')
    })
    .join('\n')
}

/**
 * Paper, or a phone screen.
 *
 * The ruled lines are spaced to the line height rather than to a fixed pitch, so the
 * text sits on the rules the way handwriting does instead of drifting across them.
 */
function surfaceCss(spec: ImageSpec, lineHeight: number): string {
  if (spec.imageClass === 'screenshot') {
    return 'background: #121212; color: #f2f2f2;'
  }
  const paper = spec.imageClass === 'handwriting' ? '#fbfaf5' : '#ffffff'
  if (!spec.augmentation.ruledPaper) return `background: ${paper}; color: #15161a;`
  return [
    `background-color: ${paper};`,
    'background-image: repeating-linear-gradient(to bottom,',
    `  rgba(0,0,0,0) 0, rgba(0,0,0,0) ${lineHeight - 1.2}px,`,
    `  rgba(84,116,168,0.38) ${lineHeight - 1.2}px, rgba(84,116,168,0.38) ${lineHeight}px);`,
    'color: #1b2b5a;',
  ].join('\n')
}

/** The transform stack: in-plane rotation, then out-of-plane tilt. */
function transform(augmentation: Augmentation): string {
  const parts: string[] = []
  if (augmentation.perspectiveDeg !== 0) {
    // Split across both axes so the distortion is a tilted sheet rather than a shear.
    parts.push(`rotateY(${augmentation.perspectiveDeg}deg)`)
    parts.push(`rotateX(${(augmentation.perspectiveDeg / 2).toFixed(2)}deg)`)
  }
  if (augmentation.rotationDeg !== 0) parts.push(`rotate(${augmentation.rotationDeg}deg)`)
  return parts.length === 0 ? 'none' : parts.join(' ')
}

/**
 * A specular highlight, deliberately short of opaque.
 *
 * The first version peaked at 0.86 alpha and washed the top third of a printed sheet to
 * about 14% contrast. Realistic — paper does that under a ceiling light — but a corpus
 * is not improved by input no engine can read: ground truth for erased text grades every
 * engine as equally wrong and tells you nothing about which is better. An augmentation
 * is useful while it degrades and useless once it erases, so the peak is capped where
 * the text is still there to be found.
 */
function glareCss(augmentation: Augmentation): string {
  const glare = augmentation.glare
  if (glare === null) return 'display: none;'
  return [
    'display: block;',
    'background: radial-gradient(circle at',
    `  ${(glare.x * 100).toFixed(1)}% ${(glare.y * 100).toFixed(1)}%,`,
    `  rgba(255,255,255,0.62) 0%, rgba(255,255,255,0.28) ${(glare.r * 35).toFixed(1)}%,`,
    `  rgba(255,255,255,0) ${(glare.r * 90).toFixed(1)}%);`,
  ].join('\n')
}

/**
 * The empty page: styles, an empty sheet, and the glare overlay.
 *
 * Deliberately holds no song text. The first version interpolated each line into this
 * string through a hand-written HTML escaper, and Semgrep blocked it — correctly, on the
 * general rule that a hand-built escape list can be circumvented. Rather than argue the
 * case or suppress the finding, the text moved out of the markup entirely: {@link
 * fillSheet} sets it through `textContent`, which is not parsed as HTML at all.
 *
 * That is the better answer anyway. Song titles are untrusted data — they come from a
 * catalogue, and in the product they come from a photograph of someone's handwriting —
 * and a title containing `</style>` should be a title containing `</style>`, not an
 * escaping bug waiting for the one character the list forgot.
 */
export function documentFor(spec: ImageSpec, font: Font): string {
  const lineHeight = lineHeightFor(spec.fontSizePx)
  const padding = paddingFor(spec.imageClass)
  // The sheet is smaller than the frame so rotating it does not swing a corner out of
  // shot. The band left over reads as the desk the paper is lying on, which is what a
  // photographed setlist looks like anyway.
  const [widthFraction, heightFraction] = sheetFractionFor(spec.imageClass)
  const sheetWidth = Math.round(spec.widthPx * widthFraction)
  const sheetHeight = Math.round(spec.heightPx * heightFraction)

  return [
    '<!doctype html><meta charset="utf-8"><style>',
    fontFaces(font, spec),
    `html, body { margin: 0; padding: 0; width: ${spec.widthPx}px; height: ${spec.heightPx}px;`,
    '  overflow: hidden; background: #d8d8d4; }',
    `.scene { width: ${spec.widthPx}px; height: ${spec.heightPx}px; perspective: 1600px;`,
    '  display: flex; align-items: center; justify-content: center; }',
    `.sheet { width: ${sheetWidth}px; height: ${sheetHeight}px; box-sizing: border-box;`,
    `  padding: ${padding}px ${padding}px;`,
    // No fallback family on purpose: if coverage were ever wrong, a missing glyph should
    // be visibly wrong rather than quietly drawn by whatever the system has.
    `  font-family: '${font.family}'; font-weight: ${spec.weight};`,
    `  font-size: ${spec.fontSizePx}px; line-height: ${lineHeight}px;`,
    `  transform: ${transform(spec.augmentation)};`,
    `  filter: blur(${spec.augmentation.blurPx}px);`,
    surfaceCss(spec, lineHeight),
    '}',
    // `pre-wrap`, never `pre`. A long credit must wrap onto a second row rather than run
    // off the edge: clipped text is text the manifest claims and the image does not show.
    '.line { white-space: pre-wrap; overflow-wrap: break-word; }',
    `.struck { text-decoration: line-through; text-decoration-thickness: ${Math.max(
      2,
      Math.round(spec.fontSizePx / 14),
    )}px; }`,
    '.heading { font-weight: 700; letter-spacing: 0.02em; }',
    spec.imageClass === 'screenshot' ? '.line { border-bottom: 1px solid #2a2a2a; }' : '.line { }',
    '.glare { position: absolute; inset: 0; pointer-events: none;',
    glareCss(spec.augmentation),
    '}',
    '</style>',
    '<div class="scene"><div class="sheet"></div></div>',
    '<div class="glare"></div>',
  ].join('\n')
}

/** The class list for one line, computed here so the page callback stays trivial. */
function classesFor(line: PlannedLine): string {
  if (line.struck) return 'line struck'
  return line.truth === null ? 'line heading' : 'line'
}

/** Put the text on the page as text, never as markup. */
export async function fillSheet(page: Page, spec: ImageSpec): Promise<void> {
  const lines = spec.lines.map((line, index) => ({
    text: line.text,
    classes: classesFor(line),
    index,
  }))
  await page.evaluate(payload => {
    const sheet = document.querySelector('.sheet')
    if (sheet === null) throw new Error('no .sheet in the document')
    for (const line of payload) {
      const element = document.createElement('div')
      element.className = line.classes
      // The index rides along so a failing overflow check can name a line rather than
      // only an image.
      element.dataset['line'] = String(line.index)
      element.textContent = line.text
      sheet.append(element)
    }
  }, lines)
}

export interface RenderedImage {
  readonly id: string
  readonly bytes: Buffer
}

/**
 * Draw one image.
 *
 * `document.fonts.ready` is awaited rather than trusted to have settled: an embedded
 * face still decodes asynchronously, and screenshotting before it lands produces a page
 * drawn in a fallback font — the exact failure the coverage rules exist to prevent,
 * arriving by a different door.
 */
export async function renderOne(page: Page, spec: ImageSpec, font: Font): Promise<RenderedImage> {
  await page.setViewportSize({ width: spec.widthPx, height: spec.heightPx })
  await page.setContent(documentFor(spec, font), { waitUntil: 'load' })
  await fillSheet(page, spec)
  await page.evaluate(() => document.fonts.ready)

  // Did every character actually land on the page?
  //
  // The wrap budget in `plan.ts` is arithmetic, and arithmetic about text layout is a
  // prediction. This is the measurement. Text that overflowed the sheet is text the
  // manifest claims and the image does not show, so the run stops rather than writing
  // another image whose ground truth is wrong in a way no later stage can detect.
  const overflow = await page.evaluate(() => {
    const sheet = document.querySelector('.sheet')
    if (sheet === null) return { by: -1, line: -1 }
    const slack = sheet.scrollHeight - sheet.clientHeight
    const line = [...sheet.querySelectorAll('.line')].findIndex(
      element => element.scrollWidth > element.clientWidth + 1,
    )
    return { by: slack, line }
  })
  if (overflow.by > 1) {
    throw new Error(
      `${spec.id}: content overflows the sheet by ${overflow.by}px at ` +
        `${spec.fontSizePx}px over ${spec.lines.length} lines — the wrap budget in ` +
        'plan.ts is wrong for this document.',
    )
  }
  if (overflow.line !== -1) {
    throw new Error(`${spec.id}: line ${overflow.line} is clipped horizontally`)
  }

  const bytes = await page.screenshot({
    type: 'jpeg',
    quality: spec.augmentation.jpegQuality,
    clip: { x: 0, y: 0, width: spec.widthPx, height: spec.heightPx },
  })
  return { id: spec.id, bytes }
}

/** The file name for a spec, inside `golden/ocr-generated/`. */
export function fileNameFor(spec: ImageSpec): string {
  return `${spec.id}.jpg`
}

export interface Renderer {
  render(spec: ImageSpec, font: Font): Promise<RenderedImage>
  close(): Promise<void>
}

/**
 * One browser and one page for the whole corpus.
 *
 * A page per image would spend most of the run in process startup. The page is reset by
 * `setContent` on every spec, so nothing carries over except the browser itself.
 */
export async function openRenderer(): Promise<Renderer> {
  const browser: Browser = await chromium.launch()
  const page = await browser.newPage()
  return {
    render: (spec, font) => renderOne(page, spec, font),
    close: () => browser.close(),
  }
}
