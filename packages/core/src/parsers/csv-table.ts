/**
 * Whole-document CSV/TSV parsing (FR-002, "CSV columns").
 *
 * This parser claims the entire document or none of it, because column meaning is a
 * document-level fact: one row of `Daft Punk,One More Time` is ambiguous, but a hundred
 * consistent rows under an `artist,title` header are not.
 *
 * Rows are parsed one line at a time rather than by streaming a reader over the whole
 * file. That costs support for newlines inside quoted fields — vanishingly rare in song
 * lists — and buys exact character offsets for every row, which FR-003 spans require.
 */

import { lineSpan, makeHints, type Line } from '../models.js'
import {
  fold,
  normalizeIsrc,
  parseDuration,
  PY_S,
  PY_WS,
  splitArtistCredits,
  stripQualifiers,
} from '../normalize.js'
import type { LineMatch } from './base.js'
import { looksLikeNoise } from './noise.js'

const DELIMITERS = [',', '\t', ';', '|'] as const

/** A table needs at least this many content rows before the shape means anything. */
const MIN_ROWS = 2
/** Recognized header labels needed to accept a row as a header. */
const MIN_HEADER_MATCHES = 2
const MAX_COLUMNS = 24
/** Values at or above this, when the column is numeric, are milliseconds not seconds. */
const MS_THRESHOLD = 1000

const COLUMN_ALIASES: Readonly<Record<string, ReadonlySet<string>>> = {
  title: new Set([
    'title',
    'track',
    'song',
    'name',
    'track name',
    'song title',
    'track title',
    'song name',
    'titel',
  ]),
  artist: new Set([
    'artist',
    'artists',
    'performer',
    'band',
    'artist name',
    'album artist',
    'artiste',
    'by',
  ]),
  album: new Set(['album', 'release', 'album name']),
  isrc: new Set(['isrc', 'isrc code']),
  duration: new Set([
    'duration',
    'length',
    'time',
    'runtime',
    'duration ms',
    'duration s',
    'track duration',
  ]),
  year: new Set(['year', 'released', 'release year', 'release date', 'date']),
}

/** Insertion order matters: the oracle iterates `_COLUMN_ALIASES` in definition order. */
const ALIAS_FIELDS = ['title', 'artist', 'album', 'isrc', 'duration', 'year'] as const

const YEAR_RE = /(?<![\p{L}\p{N}_])(1[89]\d{2}|20\d{2}|21\d{2})(?![\p{L}\p{N}_])/u
const ISRC_CELL_RE = new RegExp(
  `^[A-Za-z]{2}[A-Za-z0-9]{3}[-${PY_WS}]?\\d{2}[-${PY_WS}]?\\d{5}$`,
  'u',
)
const CLOCK_CELL_RE = /^(?:\d{1,2}:)?\d{1,2}:[0-5]\d$/u
const YEAR_CELL_RE = /^(?:1[89]\d{2}|20\d{2}|21\d{2})$/u

/** Rows needed before repeat-rate inference of the artist column is trustworthy. */
const MIN_ROWS_FOR_INFERENCE = 5
/** How much more repetitive the artist column must be than the title column. */
const REPEAT_MARGIN = 0.2
/** Fraction of cells in a column that must match a pattern to type the column by it. */
const COLUMN_TYPE_RATIO = 0.8
/** Untyped columns needed before an artist/title split is even possible. */
const MIN_PAIR_COLUMNS = 2

const STRIP_RE = new RegExp(`^${PY_S}+|${PY_S}+$`, 'gu')
const strip = (value: string): string => value.replace(STRIP_RE, '')

/** How to read a document that has been recognized as a table. */
export interface TableSpec {
  readonly delimiter: string
  readonly headerRow: number | null
  /** Logical field name → zero-based column index. */
  readonly columns: Readonly<Record<string, number>>
  /**
   * True when column roles were guessed rather than read from a header, and the guess
   * could not be corroborated from the data.
   */
  readonly ambiguous: boolean
}

/** Whether a header row was found and should be skipped. */
export const hasHeader = (spec: TableSpec): boolean => spec.headerRow !== null

/** Confidence bucket this table's rows score against. */
export const parserName = (spec: TableSpec): string =>
  hasHeader(spec) || !spec.ambiguous ? 'csv' : 'csv_headerless'

/**
 * Split one physical line with csv quoting rules applied.
 *
 * A hand-written reader rather than a dependency, and it reproduces Python's
 * `csv.reader(..., skipinitialspace=True)` specifically: a field is quoted only when the
 * quote is its first character after any skipped spaces, `""` inside a quoted field is a
 * literal quote, and a quote in the middle of an unquoted field is just a character.
 * Getting that last rule wrong turns `Artist,Say "Yes"` into a parse error in one
 * language and a title in the other.
 */
export function splitRow(text: string, delimiter: string): string[] {
  const cells: string[] = []
  let i = 0
  const n = text.length

  while (true) {
    // skipinitialspace: spaces (not all whitespace) after a delimiter are dropped.
    while (i < n && text[i] === ' ') i += 1

    let value = ''
    if (i < n && text[i] === '"') {
      i += 1
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            value += '"'
            i += 2
            continue
          }
          i += 1
          break
        }
        value += text[i]
        i += 1
      }
      // Anything after the closing quote and before the delimiter is appended, which is
      // what Python's reader does outside strict mode.
      while (i < n && text[i] !== delimiter) {
        value += text[i]
        i += 1
      }
    } else {
      while (i < n && text[i] !== delimiter) {
        value += text[i]
        i += 1
      }
    }

    cells.push(strip(value))
    if (i >= n) break
    i += 1 // consume the delimiter
    if (i === n) {
      // A trailing delimiter yields one more empty field, as Python's reader does.
      cells.push('')
      break
    }
  }

  // Python's reader yields nothing at all for an empty line.
  if (cells.length === 1 && cells[0] === '' && text === '') return []
  return cells
}

/** Map recognized header labels to column indices. */
function matchHeader(cells: string[]): Record<string, number> {
  const mapping: Record<string, number> = {}
  for (const [index, cell] of cells.entries()) {
    const label = fold(cell)
    for (const field of ALIAS_FIELDS) {
      if (COLUMN_ALIASES[field]!.has(label) && !(field in mapping)) mapping[field] = index
    }
  }
  return mapping
}

/** The non-empty cells of one column. */
function column(rows: string[][], index: number): string[] {
  return rows.filter(row => index < row.length && strip(row[index]!)).map(row => strip(row[index]!))
}

/** The first column whose cells overwhelmingly match `pattern`. */
function typedColumn(rows: string[][], width: number, pattern: RegExp): number | null {
  for (let index = 0; index < width; index += 1) {
    const cells = column(rows, index)
    if (cells.length === 0) continue
    const hits = cells.filter(cell => pattern.test(cell)).length
    if (hits / cells.length >= COLUMN_TYPE_RATIO) return index
  }
  return null
}

/** Pick the artist column of two candidates by comparing repeat rates. */
function inferDirection(
  rows: string[][],
  first: number,
  second: number,
): [number, number, boolean] {
  const left = column(rows, first)
  const right = column(rows, second)
  if (Math.min(left.length, right.length) < MIN_ROWS_FOR_INFERENCE) return [first, second, true]

  const leftDistinct = new Set(left.map(fold)).size / left.length
  const rightDistinct = new Set(right.map(fold)).size / right.length
  if (leftDistinct + REPEAT_MARGIN < rightDistinct) return [first, second, false]
  if (rightDistinct + REPEAT_MARGIN < leftDistinct) return [second, first, false]
  // Both equally distinct: fall back to the dominant export order, artist first.
  return [first, second, true]
}

/**
 * Assign column roles for a headerless table from cell content.
 *
 * ISRC, clock and year columns are recognized by shape. The artist/title split uses
 * repetition: across a real tracklist, artists recur and titles do not, so the less
 * distinct of the two candidate columns is the artist. When the margin is too thin to
 * call — or the table is too short to measure — the spec is marked ambiguous and its rows
 * land in review rather than being auto-accepted on a coin flip.
 */
function inferSpec(delimiter: string, rows: string[][], width: number): TableSpec {
  const columns: Record<string, number> = {}
  const typed = new Set<number>()

  for (const [field, pattern] of [
    ['isrc', ISRC_CELL_RE],
    ['duration', CLOCK_CELL_RE],
    ['year', YEAR_CELL_RE],
  ] as const) {
    const index = typedColumn(rows, width, pattern)
    if (index !== null && !typed.has(index)) {
      columns[field] = index
      typed.add(index)
    }
  }

  const remaining = Array.from({ length: width }, (_, i) => i).filter(i => !typed.has(i))
  if (remaining.length < MIN_PAIR_COLUMNS) {
    // Nothing to split artist from title.
    columns['title'] = remaining[0] ?? 0
    return { delimiter, headerRow: null, columns, ambiguous: true }
  }

  const [first, second] = [remaining[0]!, remaining[1]!]
  const [artistIndex, titleIndex, ambiguous] = inferDirection(rows, first, second)
  columns['artist'] = artistIndex
  columns['title'] = titleIndex
  if (remaining.length > MIN_PAIR_COLUMNS && !('album' in columns)) {
    columns['album'] = remaining[2]!
  }
  return { delimiter, headerRow: null, columns, ambiguous }
}

/**
 * Decide whether the document is a delimited table, and how to read it.
 *
 * A header is not required: a headerless table with a stable column count is read as
 * `artist, title` — the same convention the dash parser uses — and its rows are flagged
 * ambiguous so they surface in review.
 */
export function detectTable(lines: readonly Line[]): TableSpec | null {
  const content = lines.filter(line => !looksLikeNoise(line.text))
  if (content.length < MIN_ROWS) return null

  for (const delimiter of DELIMITERS) {
    const rows = content.map(line => splitRow(line.text, delimiter))
    const widths = new Set(rows.map(row => row.length))
    if (widths.size !== 1) continue
    const width = [...widths][0]!
    if (width < MIN_PAIR_COLUMNS || width > MAX_COLUMNS) continue

    const columns = matchHeader(rows[0]!)
    if (
      'title' in columns ||
      ('artist' in columns && Object.keys(columns).length >= MIN_HEADER_MATCHES)
    ) {
      return { delimiter, headerRow: 0, columns, ambiguous: false }
    }
    return inferSpec(delimiter, rows, width)
  }
  return null
}

/** Read one logical field from a row, if the table has that column. */
function cell(cells: string[], spec: TableSpec, field: string): string | null {
  const index = spec.columns[field]
  if (index === undefined || index >= cells.length) return null
  const value = strip(cells[index]!)
  return value || null
}

/** Interpret a duration cell as `mm:ss`, milliseconds, or seconds. */
function durationSeconds(raw: string): number | null {
  const clock = parseDuration(raw)
  if (clock !== null) return clock
  // Python's `float()` accepts leading/trailing space, a sign, and exponents, and
  // rejects everything else — notably the empty string, which `Number("")` makes 0.
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u.test(strip(raw))) return null
  const number = Number(strip(raw))
  if (!(number > 0)) return null
  return number >= MS_THRESHOLD ? number / 1000 : number
}

/** Pull a four-digit year out of a year or release-date cell. */
function parseYear(raw: string | null): number | null {
  if (!raw) return null
  const match = YEAR_RE.exec(raw)
  return match ? Number(match[1]) : null
}

/** Parse every data row of a recognized table into matches. */
export function parseTable(lines: readonly Line[], spec: TableSpec): LineMatch[] {
  const matches: LineMatch[] = []

  for (const [index, line] of lines.entries()) {
    if (looksLikeNoise(line.text)) continue
    if (
      spec.headerRow !== null &&
      matches.length === 0 &&
      Object.keys(matchHeader(splitRow(line.text, spec.delimiter))).length > 0
    ) {
      // Skip the header itself; guarded on an empty `matches` so a data row that happens
      // to contain the word "title" later in the file is still parsed.
      continue
    }

    const cells = splitRow(line.text, spec.delimiter)
    const rawTitle = cell(cells, spec, 'title')
    if (!rawTitle) continue

    const { base: title, qualifiers, featured, versionLabel } = stripQualifiers(rawTitle)
    if (!title) continue

    let artist: string | null = null
    let credited: string[] = []
    const rawArtist = cell(cells, spec, 'artist')
    if (rawArtist) {
      const [primary, feat] = splitArtistCredits(rawArtist)
      artist = primary || null
      credited = feat
    }

    const span = lineSpan(line)
    if (span === null) continue

    const rawDuration = cell(cells, spec, 'duration')
    const rawIsrc = cell(cells, spec, 'isrc')

    matches.push({
      title,
      artist,
      span,
      parser: parserName(spec),
      hints: makeHints({
        album: cell(cells, spec, 'album'),
        year: parseYear(cell(cells, spec, 'year')),
        isrc: rawIsrc ? normalizeIsrc(rawIsrc) : null,
        durationS: rawDuration ? durationSeconds(rawDuration) : null,
        featuredArtists: [...new Set([...featured, ...credited])],
        qualifiers,
        versionLabel,
        position: index + 1,
      }),
      ambiguousDirection: spec.ambiguous,
      structured: true,
    })
  }
  return matches
}
