/**
 * The corpus plan: every image this generator will draw, decided before a browser opens.
 *
 * Nothing here renders anything. A plan entry says which seed rows an image contains,
 * which font draws them, and exactly which distortions are applied — all of it derived
 * from one integer seed. That split is deliberate and it is what makes the determinism
 * claim checkable:
 *
 * - **The plan is deterministic everywhere.** Pure data from a fixed seed, so the same
 *   manifest comes out on Windows and on Linux CI, and `make golden-check` can prove it
 *   without a browser or a five-minute render.
 * - **The pixels are deterministic per platform and browser version.** Text rasterizing
 *   is FreeType's business and it is not byte-identical across operating systems. Saying
 *   otherwise would be a claim that fails in CI the first time anyone checked, so the
 *   committed artifact is the manifest and the images are rebuilt wherever they are
 *   needed.
 *
 * ## Two truths, because a struck-out line has two right answers
 *
 * Draw a line through a song and OCR should still read it — the ink is on the page. The
 * extractor should not return it — the writer crossed it out. A corpus with one truth
 * field has to pick one of those and be wrong about the other, so there are two:
 * `line.text` is what OCR is graded against, and {@link songTruth} is what the pipeline
 * is graded against. M2-05 scores CER and WER on the first and song-level F1 on the
 * second.
 *
 * ## Truth never comes from a renderer
 *
 * Same rule as the text corpus, for the same reason: `truthFor` derives the answer from
 * the seed row's own join phrases. A renderer may only *add* things the contract says
 * are removable — a list marker, a timestamp. Whatever it did, the answer is still the
 * seed's title and the seed's primary credit.
 */

import { Rng, isUsable, truthFor, type SeedRow, type Truth } from '@setlist/golden-gen'

import { covers, subsetsFor, type Font } from './fonts.js'

/** The seed. Changing it rewrites the whole corpus, so it is a decision, not a knob. */
export const OCR_CORPUS_SEED = 20261003

/**
 * The ceiling on rotation, straight from M2-01.
 *
 * A phone held over a sheet of paper is off-axis by a few degrees. Beyond about seven,
 * the deskew step in the capture pipeline (M2-02) is supposed to reject the frame and
 * ask for a retake, so a corpus full of 20-degree images would be grading OCR on input
 * the product never forwards.
 */
export const MAX_ROTATION_DEG = 7

/**
 * Page geometry, here rather than in the renderer because the planner has to size the
 * text to fit and both halves must agree about what "fit" means.
 *
 * The first version of this generator clipped. Lines were drawn with `overflow: hidden`
 * and a long credit simply ran off the right edge — "Killer Cars - Radiohead" came out
 * as "...- Radio". The manifest still claimed the whole string, so every one of those
 * images was ground truth for text that was not on the page, and CER would have been
 * measured against characters no engine could have read. A corpus that lies in that
 * direction is worse than no corpus, because the number it produces looks fine.
 *
 * Two changes fix it and a third proves it. Text wraps instead of clipping, so nothing
 * can leave the page sideways. The font size is derived from the line count with room
 * for every line to wrap once, so nothing leaves the bottom. And the renderer asserts
 * after layout that the content really did fit, so if either calculation is ever wrong
 * the run fails instead of quietly producing more of what this comment describes.
 */
export const SHEET_WIDTH_FRACTION = 0.88
export const SHEET_HEIGHT_FRACTION = 0.92
export const LINE_HEIGHT_RATIO = 1.65

/**
 * How much of the frame the page occupies.
 *
 * A photographed sheet sits inside the frame with desk around it, which is also the room
 * a rotation needs so a corner does not swing out of shot. A screenshot is the frame —
 * there is no surface it was photographed on, and a border around one would be a thing
 * the capture pipeline can never receive.
 */
export function sheetFractionFor(imageClass: ImageClass): readonly [number, number] {
  return imageClass === 'screenshot' ? [1, 1] : [SHEET_WIDTH_FRACTION, SHEET_HEIGHT_FRACTION]
}

/** Vertical room reserved per line: one row, plus one in case it wraps. */
export const WRAP_BUDGET_ROWS = 2

/**
 * The longest `title + artist` a row may contribute.
 *
 * `isUsable` already caps a title at 90 characters and a credit at 70, which together
 * would be a 160-character line — three or four wrapped rows at the larger sizes, and a
 * document of nothing but run-on lines. This is the tighter bound that keeps the wrap
 * budget above honest.
 */
export const MAX_CREDIT_CHARS = 60

/** Margin inside the sheet, in pixels. */
export function paddingFor(imageClass: ImageClass): number {
  return imageClass === 'screenshot' ? 48 : 96
}

export type ImageClass = 'handwriting' | 'print' | 'screenshot'

export const IMAGE_CLASSES: readonly ImageClass[] = ['handwriting', 'print', 'screenshot']

/** How many images of each class. Together they clear M2-01's floor of 600. */
export const CLASS_COUNTS: Readonly<Record<ImageClass, number>> = {
  handwriting: 220,
  print: 220,
  screenshot: 180,
}

export interface PlannedLine {
  /** Exactly the characters drawn on this line. What CER and WER are measured against. */
  readonly text: string
  /** Drawn with a line through it: visible to OCR, excluded from the song truth. */
  readonly struck: boolean
  /** The seed row this line carries, or `null` for a heading or other chrome. */
  readonly truth: Truth | null
}

export interface Augmentation {
  /** Degrees, `|x| <= MAX_ROTATION_DEG`. */
  readonly rotationDeg: number
  /** Degrees of out-of-plane tilt; 0 means the page is flat to the lens. */
  readonly perspectiveDeg: number
  readonly blurPx: number
  /** Centre and radius of a specular highlight, as fractions of the image. */
  readonly glare: { readonly x: number; readonly y: number; readonly r: number } | null
  /** JPEG quality, 1-100. Lower is noisier. */
  readonly jpegQuality: number
  readonly ruledPaper: boolean
}

export interface ImageSpec {
  readonly id: string
  readonly imageClass: ImageClass
  readonly fontPkg: string
  readonly family: string
  readonly weight: number
  /** The fontsource subset files this document needs embedded. */
  readonly subsets: readonly string[]
  readonly fontSizePx: number
  readonly widthPx: number
  readonly heightPx: number
  readonly lines: readonly PlannedLine[]
  readonly augmentation: Augmentation
  /** The songs the extractor should return: every unstruck line that carries a row. */
  readonly songTruth: readonly Truth[]
}

/** The songs a planned document should yield, which is not every line it shows. */
export function songTruth(lines: readonly PlannedLine[]): Truth[] {
  return lines.filter(line => !line.struck && line.truth !== null).map(line => line.truth!)
}

/**
 * Headings a real setlist carries.
 *
 * Deliberately not song-like: every one of these must be rejected by the extractor, and
 * a heading that reads as "Artist - Title" would be testing nothing.
 */
const HEADINGS = ['Set List', 'Saturday', 'Encore', 'Second set', 'Sound check', 'Friday night']

/** Separators, limited to the ones the extraction contract actually names. */
const SEPARATORS = [' - ', ' – ', ' — ', ' ~ ']

interface ClassProfile {
  readonly fonts: readonly string[]
  readonly weights: readonly number[]
  readonly widthPx: number
  readonly heightPx: number
  readonly fontSizePx: readonly [number, number]
  readonly lines: readonly [number, number]
}

/**
 * What each class of image looks like, and what may be done to it.
 *
 * The distinction that matters is in `augment` below rather than here: a screenshot is
 * a framebuffer copy, so it has no rotation, no perspective, no glare and no paper. Any
 * of those in a screenshot would be a distortion the product can never receive, and
 * grading OCR against impossible input makes the number mean less, not more.
 */
const PROFILES: Readonly<Record<ImageClass, ClassProfile>> = {
  handwriting: {
    fonts: [
      '@fontsource/caveat',
      '@fontsource/patrick-hand',
      '@fontsource/indie-flower',
      '@fontsource/architects-daughter',
      '@fontsource/shadows-into-light',
      '@fontsource/homemade-apple',
      '@fontsource/rock-salt',
      '@fontsource/reenie-beanie',
    ],
    weights: [400],
    widthPx: 1224,
    heightPx: 1632,
    fontSizePx: [34, 52],
    lines: [6, 14],
  },
  print: {
    fonts: [
      '@fontsource/roboto',
      '@fontsource/open-sans',
      '@fontsource/noto-sans',
      '@fontsource/lora',
    ],
    weights: [400, 700],
    widthPx: 1224,
    heightPx: 1632,
    fontSizePx: [28, 44],
    lines: [8, 18],
  },
  screenshot: {
    fonts: ['@fontsource/inter', '@fontsource/roboto', '@fontsource/roboto-mono'],
    weights: [400, 500],
    widthPx: 1080,
    heightPx: 1920,
    fontSizePx: [30, 40],
    lines: [8, 16],
  },
}

/**
 * The largest font size at which `lineCount` lines still fit, capped to the class range.
 *
 * Derived rather than drawn from the PRNG. A size picked at random is a size that
 * sometimes overflows, and "sometimes" in a corpus of 620 means a handful of silently
 * truncated images nobody looks at.
 */
export function lineHeightFor(fontSizePx: number): number {
  return Math.round(fontSizePx * LINE_HEIGHT_RATIO)
}

/** The height available to text inside the sheet. */
export function usableHeight(imageClass: ImageClass, heightPx: number): number {
  return heightPx * sheetFractionFor(imageClass)[1] - 2 * paddingFor(imageClass)
}

export function fontSizeFor(
  imageClass: ImageClass,
  heightPx: number,
  lineCount: number,
  range: readonly [number, number],
): number {
  const usable = usableHeight(imageClass, heightPx)
  // Searched down from the largest rather than solved for directly, because the renderer
  // rounds the line height to whole pixels and a closed form does not. The first version
  // divided by the unrounded ratio and overflowed by 4.6px at nine lines — 72.6 became
  // 73, nine times, twice over. A search against the number the renderer will actually
  // use cannot drift from it.
  for (let size = range[1]; size > range[0]; size -= 1) {
    if (lineCount * WRAP_BUDGET_ROWS * lineHeightFor(size) <= usable) return size
  }
  return range[0]
}

/**
 * The most lines that fit at a class's smallest size.
 *
 * {@link fontSizeFor} clamps upward to keep text legible, so on its own it would hand
 * back the minimum size for a line count that does not fit at any size. Capping the
 * count first is what makes the clamp safe.
 */
export function maxLinesFor(imageClass: ImageClass, heightPx: number, minFontSize: number): number {
  return Math.floor(
    usableHeight(imageClass, heightPx) / (WRAP_BUDGET_ROWS * lineHeightFor(minFontSize)),
  )
}

/** Every font package the plan can reach for, deduplicated. */
export function plannedFontPackages(): string[] {
  return [...new Set(IMAGE_CLASSES.flatMap(cls => PROFILES[cls].fonts))].sort()
}

function augment(rng: Rng, imageClass: ImageClass): Augmentation {
  // A screenshot is a copy of a framebuffer. It can be recompressed and it can be
  // slightly blurred by a downscale, and that is the whole list.
  if (imageClass === 'screenshot') {
    return {
      rotationDeg: 0,
      perspectiveDeg: 0,
      blurPx: rng.chance(0.25) ? rng.int(1, 2) / 2 : 0,
      glare: null,
      jpegQuality: rng.chance(0.5) ? rng.int(55, 92) : 100,
      ruledPaper: false,
    }
  }

  const rotated = rng.chance(0.75)
  return {
    // `int` over tenths of a degree rather than a float, so the manifest holds a short
    // decimal and two runs cannot differ in the sixteenth place.
    rotationDeg: rotated ? rng.int(-MAX_ROTATION_DEG * 10, MAX_ROTATION_DEG * 10) / 10 : 0,
    perspectiveDeg: rng.chance(0.45) ? rng.int(-120, 120) / 10 : 0,
    blurPx: rng.chance(0.4) ? rng.int(1, 5) / 2 : 0,
    glare: rng.chance(0.3)
      ? { x: rng.int(15, 85) / 100, y: rng.int(10, 70) / 100, r: rng.int(25, 60) / 100 }
      : null,
    jpegQuality: rng.int(45, 95),
    ruledPaper: imageClass === 'handwriting' ? rng.chance(0.55) : rng.chance(0.15),
  }
}

/** One song line, as it is written down. */
function lineFor(rng: Rng, row: SeedRow, style: string, index: number): string {
  const truth = truthFor(row)
  const separator = rng.pick(SEPARATORS)
  const body =
    style === 'title-first'
      ? `${truth.title}${separator}${truth.artist}`
      : style === 'by'
        ? `${truth.title} by ${truth.artist}`
        : `${truth.artist}${separator}${truth.title}`

  switch (rng.int(0, 3)) {
    case 0:
      return `${index + 1}. ${body}`
    case 1:
      return `${index + 1}) ${body}`
    case 2:
      return `- ${body}`
    default:
      return body
  }
}

/**
 * Build one document's lines.
 *
 * The caller has already restricted `rows` to ones this font can draw, so nothing here
 * can produce a character the renderer would have to fall back for.
 */
function linesFor(rng: Rng, rows: readonly SeedRow[], imageClass: ImageClass): PlannedLine[] {
  const lines: PlannedLine[] = []

  // A heading, sometimes. It carries no truth, so it is also the corpus's check that the
  // extractor does not invent a song out of a date or a venue.
  if (rng.chance(imageClass === 'screenshot' ? 0.85 : 0.4)) {
    lines.push({ text: rng.pick(HEADINGS), struck: false, truth: null })
  }

  const style = rng.pick(['artist-first', 'title-first', 'by'])
  rows.forEach((row, index) => {
    // Crossing a song out is a handwriting habit. It happens on a printed sheet someone
    // marked up too, and never in a screenshot.
    const struck = imageClass === 'screenshot' ? false : rng.chance(0.08)
    lines.push({ text: lineFor(rng, row, style, index), struck, truth: truthFor(row) })
  })

  return lines
}

/**
 * The whole corpus, from the seed and one integer.
 *
 * `fonts` is passed in rather than loaded here so the planner stays pure and the tests
 * can hand it a font set they control — including one that covers nothing, which is how
 * the "no row is offered to a font that cannot draw it" rule is checked from the failing
 * side.
 */
export function planCorpus(
  rows: readonly SeedRow[],
  fonts: ReadonlyMap<string, Font>,
  seed = OCR_CORPUS_SEED,
): ImageSpec[] {
  const rng = new Rng(seed)
  const usable = rows.filter(isUsable)

  // Per font, the rows it can draw. Computed once: `covers` walks every codepoint, and
  // doing it per image would be ~600 times the work for the same answer.
  const pools = new Map<string, SeedRow[]>()
  for (const [pkg, font] of fonts) {
    pools.set(
      pkg,
      usable.filter(row => {
        const truth = truthFor(row)
        if (truth.title.length + truth.artist.length > MAX_CREDIT_CHARS) return false
        return covers(font, `${truth.title} ${truth.artist}`)
      }),
    )
  }

  const specs: ImageSpec[] = []
  for (const imageClass of IMAGE_CLASSES) {
    const profile = PROFILES[imageClass]
    for (let index = 0; index < CLASS_COUNTS[imageClass]; index += 1) {
      const pkg = rng.pick(profile.fonts)
      const font = fonts.get(pkg)
      if (font === undefined) throw new Error(`no font loaded for ${pkg}`)
      const pool = pools.get(pkg)!
      if (pool.length === 0) throw new Error(`${pkg} can draw no row in the seed`)

      const ceiling = maxLinesFor(imageClass, profile.heightPx, profile.fontSizePx[0])
      // `ceiling - 1` leaves room for the heading `linesFor` may prepend.
      const count = Math.min(rng.int(profile.lines[0], profile.lines[1]), ceiling - 1)
      const lines = linesFor(rng, rng.sample(pool, count), imageClass)

      const text = lines.map(line => line.text).join('\n')
      const subsets = subsetsFor(font, text)
      // Unreachable while the pool is built from the same `covers` call, and asserted
      // rather than assumed because a silent fallback is invisible in the output: the
      // image would simply be drawn in a system font nobody licensed.
      if (subsets === null) throw new Error(`${pkg} cannot draw its own pool`)

      specs.push({
        id: `${imageClass}-${String(index + 1).padStart(4, '0')}`,
        imageClass,
        fontPkg: pkg,
        family: font.family,
        weight: rng.pick(profile.weights),
        subsets,
        fontSizePx: fontSizeFor(imageClass, profile.heightPx, lines.length, profile.fontSizePx),
        widthPx: profile.widthPx,
        heightPx: profile.heightPx,
        lines,
        augmentation: augment(rng, imageClass),
        songTruth: songTruth(lines),
      })
    }
  }
  return specs
}
