/**
 * How a song list gets written down, in the shapes people actually write them.
 *
 * Every renderer takes rows whose truth is already known and produces text. None of them
 * reads the parser, and none of them changes a title or an artist except by *adding*
 * something the extraction contract says is removable — a list marker, a timestamp, a
 * qualifier. That restraint is what keeps `expected` honest: whatever the renderer did,
 * the answer is still the seed's title and the seed's primary credit.
 *
 * CORE-03 names the shapes: numbered and bulleted lists, `by`, CSV, timestamps, both
 * dash orders per source kind, chat and Reddit prose, typos, emoji, odd casing,
 * multilingual. Each gets a renderer here and a slot in `generate.ts`.
 */

import type { Rng } from './rng.js'
import type { SeedRow } from './seed.js'
import { primaryArtist } from './truth.js'

/**
 * Separators, taken from the contract rather than from imagination.
 *
 * `_SEPARATOR_RE` in the parser accepts `[-~|/•·]` surrounded by spaces, and the three
 * long dashes with or without them. A first draft of this list included ` -- `, which is
 * not in that set — the generator then asserted that every double-hyphen line should
 * parse, scored the extractor at 0.37 on a recipe, and the number looked like an
 * extractor problem rather than a made-up requirement. Generating input the contract
 * never promised to handle is how a golden set starts lying.
 */
const DASHES = [' - ', ' – ', ' — ', ' · ', ' ~ ']

/**
 * ` | ` is a contract separator and is still deliberately absent above.
 *
 * A pipe is also how a markdown table is written, so `detect_table` claims the document
 * and parses "1) Queen | Somebody to Love" as two columns — leaving the list marker
 * glued to the artist as "1) Queen". That is a reasonable reading of a pipe-delimited
 * file, not a bug, and the table shapes are covered by the CSV recipes. Mixing a list
 * marker with a pipe just manufactures an ambiguity nobody has to resolve.
 */

/**
 * Bullets, plain only.
 *
 * Emoji bullets are deliberately NOT here. A leading 🎵 is not stripped as a list marker,
 * so the artist comes back as "🎵 Mukesh & Lata Mangeshkar" — a real gap, and one this
 * corpus records in the `emoji-leading` recipe rather than hiding by not generating it.
 */
const BULLETS = ['-', '*', '•', '‣', '–']

/** Emoji used the way a bullet is used, which the extractor does not yet handle. */
const EMOJI_BULLETS = ['🎵', '🎧', '▶', '🔥']

/**
 * Qualifiers the extractor is contracted to peel into hints (PRD §7.9.1).
 *
 * Only these appear in generated titles. A renderer that invented its own annotation
 * would be asserting the parser should strip something nobody promised it would.
 */
const QUALIFIERS = [
  '(Live)',
  '(Remastered)',
  '(2011 Remaster)',
  '(Acoustic)',
  '(Radio Edit)',
  '(Instrumental)',
  '(Extended Mix)',
  '- Live',
]

export interface Rendered {
  readonly text: string
  /** Rows that actually made it into the text, in order. */
  readonly used: readonly SeedRow[]
}

/** One list line's leading marker, given a shape and a position. */
function marker(rng: Rng, style: string, index: number): string {
  switch (style) {
    case 'numbered-dot':
      return `${index + 1}. `
    case 'numbered-paren':
      return `${index + 1}) `
    case 'numbered-bare':
      return `${index + 1} `
    case 'bullet':
      return `${rng.pick(BULLETS)} `
    case 'emoji-bullet':
      return `${rng.pick(EMOJI_BULLETS)} `
    case 'timestamp': {
      // A running clock, so successive lines are plausibly ordered rather than random.
      const seconds = index * rng.int(150, 320)
      const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
      const ss = String(seconds % 60).padStart(2, '0')
      return `${mm}:${ss} `
    }
    default:
      return ''
  }
}

/** `Artist - Title`, the commonest shape there is. */
export function artistFirst(rng: Rng, rows: readonly SeedRow[], style: string): Rendered {
  const dash = rng.pick(DASHES)
  const lines = rows.map(
    (row, i) => `${marker(rng, style, i)}${primaryArtist(row)}${dash}${row.title}`,
  )
  return { text: `${lines.join('\n')}\n`, used: rows }
}

/**
 * `Title - Artist`, with a qualifier on the title.
 *
 * The reversed order is required coverage, and on its own it is genuinely ambiguous —
 * "A - B" gives a reader no way to know which side is the song. The extractor resolves
 * it the way the contract says (`has_version_annotation`: version markers attach to
 * titles, not to artist names), so these rows carry a qualifier. Reversed lines with no
 * qualifier are generated too, but as a noisy case scored on precision, because asking
 * for recall on a line that is undecidable would be asking the parser to guess.
 */
export function titleFirstWithQualifier(
  rng: Rng,
  rows: readonly SeedRow[],
  style: string,
): Rendered {
  const dash = rng.pick(DASHES)
  const lines = rows.map(
    (row, i) =>
      `${marker(rng, style, i)}${row.title} ${rng.pick(QUALIFIERS)}${dash}${primaryArtist(row)}`,
  )
  return { text: `${lines.join('\n')}\n`, used: rows }
}

/** `Title - Artist` with nothing to disambiguate it. Noisy on purpose. */
export function titleFirstAmbiguous(rng: Rng, rows: readonly SeedRow[], style: string): Rendered {
  const dash = rng.pick(DASHES)
  const lines = rows.map(
    (row, i) => `${marker(rng, style, i)}${row.title}${dash}${primaryArtist(row)}`,
  )
  return { text: `${lines.join('\n')}\n`, used: rows }
}

/** `"Title" by Artist` and `Title by Artist`. */
export function byForm(rng: Rng, rows: readonly SeedRow[], style: string): Rendered {
  const quoted = rng.chance(0.6)
  const lines = rows.map((row, i) => {
    const title = quoted ? `"${row.title}"` : row.title
    return `${marker(rng, style, i)}${title} by ${primaryArtist(row)}`
  })
  return { text: `${lines.join('\n')}\n`, used: rows }
}

/**
 * A spreadsheet export, with or without the header row.
 *
 * With a header, either column order is fair game: the header says which is which, and
 * reading it is the parser's job. Without one, the order is only a convention, and the
 * parser's convention is artist-first — so `headerless` renders artist-first.
 * Randomizing it instead scored the recipe at 0.54, and every failure was a swap. That
 * is not the parser being wrong about anything; it is a question the text does not
 * answer. The reversed headerless shape is generated as a noisy case, where an
 * unanswerable question belongs.
 */
export function csv(
  rng: Rng,
  rows: readonly SeedRow[],
  withHeader: boolean,
  titleFirstColumns = false,
): Rendered {
  const sep = rng.pick([',', '\t', ';'])
  const quote = (value: string): string =>
    value.includes(sep) || value.includes('"') ? `"${value.replaceAll('"', '""')}"` : value

  const artistFirstColumns = withHeader ? rng.chance(0.5) : !titleFirstColumns
  const header = artistFirstColumns ? ['Artist', 'Title'] : ['Title', 'Artist']

  const lines: string[] = []
  if (withHeader) lines.push(header.join(sep))
  for (const row of rows) {
    const cells = artistFirstColumns
      ? [primaryArtist(row), row.title]
      : [row.title, primaryArtist(row)]
    lines.push(cells.map(quote).join(sep))
  }
  return { text: `${lines.join('\n')}\n`, used: rows }
}

/** A title with a featured credit spelled out inline. */
export function featuredInline(rng: Rng, rows: readonly SeedRow[], style: string): Rendered {
  const dash = rng.pick(DASHES)
  const lines = rows.map((row, i) => `${marker(rng, style, i)}${row.artist}${dash}${row.title}`)
  return { text: `${lines.join('\n')}\n`, used: rows }
}

/** A qualifier on the title, in the normal artist-first order. */
export function withQualifier(rng: Rng, rows: readonly SeedRow[], style: string): Rendered {
  const dash = rng.pick(DASHES)
  const lines = rows.map(
    (row, i) =>
      `${marker(rng, style, i)}${primaryArtist(row)}${dash}${row.title} ${rng.pick(QUALIFIERS)}`,
  )
  return { text: `${lines.join('\n')}\n`, used: rows }
}

const THREAD_OPENERS = [
  'been on repeat all week',
  'my top tracks this month',
  'what i played at the party',
  'anyone else into these',
  'the set from last night, roughly',
  'adding these to the road trip playlist',
]

const THREAD_CLOSERS = [
  'let me know what you think',
  'open to suggestions',
  'thanks in advance',
  'full set was longer but these were the highlights',
]

/** A forum post: prose around a list, which is the actual Reddit shape. */
export function redditPost(rng: Rng, rows: readonly SeedRow[], style: string): Rendered {
  const body = artistFirst(rng, rows, style).text
  const head = `${rng.pick(THREAD_OPENERS)}\n\n`
  const tail = rng.chance(0.7) ? `\n${rng.pick(THREAD_CLOSERS)}\n` : ''
  return { text: `${head}${body}${tail}`, used: rows }
}

/**
 * A chat message, where the songs are inside sentences rather than on their own lines.
 *
 * Always a noisy case. The deterministic pass is not responsible for pulling a song out
 * of "omg have you heard X - Y" — that is precisely the residual the Bedrock pass gets
 * (PRD §7.9.3) — so these are scored on precision only. What they are really testing is
 * that the parser does not *invent* something from prose.
 */
export function chat(rng: Rng, rows: readonly SeedRow[]): Rendered {
  const frames = [
    (s: string) => `omg have u heard ${s}`,
    (s: string) => `${s} is so good??`,
    (s: string) => `put ${s} on pls`,
    (s: string) => `ok but ${s} though`,
    (s: string) => `someone said ${s} and i felt that`,
  ]
  const dash = rng.pick(DASHES)
  const lines = rows.map(row => rng.pick(frames)(`${primaryArtist(row)}${dash}${row.title}`))
  return { text: `${lines.join('\n')}\n`, used: rows }
}

/** Lines of noise that are not songs and must not become songs. */
const DISTRACTORS = [
  'https://example.com/playlist/12345',
  '---',
  '### tracklist',
  'posted by u/someone 4 hours ago',
  'Edit: fixed the order',
  '(sorry for the formatting)',
  '12 comments  share  save',
  '**Tracklist**',
]

/** Sprinkle non-song lines through a rendered document. */
export function withDistractors(rng: Rng, rendered: Rendered, howMany: number): Rendered {
  const lines = rendered.text.split('\n')
  for (let i = 0; i < howMany; i += 1) {
    lines.splice(rng.int(0, lines.length), 0, rng.pick(DISTRACTORS))
  }
  return { text: lines.join('\n'), used: rendered.used }
}
