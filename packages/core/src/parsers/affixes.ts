/**
 * Strip list scaffolding off a line before pattern parsing.
 *
 * Real-world song lists wrap the actual "artist - title" payload in ordinals, bullets,
 * DJ cue timestamps, trailing run times and stray ISRCs. Peeling those first means the
 * pair parsers only ever see the payload, and the peeled values become structured hints
 * instead of noise inside a title.
 *
 * Every function here preserves document coordinates: the returned `Line` carries an
 * offset adjusted by exactly the number of characters consumed, so spans built from it
 * still point at the right characters in `SourceDocument.text`.
 */

import { makeHints, makeLine, type Hints, type Line } from '../models.js'
import { normalizeIsrc, parseDuration, PY_S, PY_WS } from '../normalize.js'

const BULLETS = '-*•‣·◦⁃∙>+'

/** Escape a string for use inside a regex character class. */
const escapeClass = (value: string): string => value.replace(/[\\\]^-]/gu, '\\$&')

/**
 * "1. ", "12) ", "#3 - ", "[4] " — capped at three digits so a leading year such as
 * "1979 - Smashing Pumpkins" is never mistaken for an ordinal.
 */
const ORDINAL_RE = new RegExp(`^${PY_S}*#?${PY_S}*(\\d{1,3})${PY_S}*[.)\\]:–—-]${PY_S}+`, 'u')
const BRACKET_ORDINAL_RE = new RegExp(
  `^${PY_S}*[[(]${PY_S}*(\\d{1,3})${PY_S}*[\\])]${PY_S}*[.)–—-]?${PY_S}+`,
  'u',
)
const BULLET_RE = new RegExp(`^${PY_S}*[${escapeClass(BULLETS)}]${PY_S}+`, 'u')

/** "00:03", "[1:02:17]", "(4:21) " — DJ cue sheets and timestamped tracklists. */
const TIMESTAMP_RE = new RegExp(
  `^${PY_S}*[[(]?${PY_S}*((?:\\d{1,2}:)?\\d{1,2}:[0-5]\\d)${PY_S}*[\\])]?${PY_S}*[.)–—-]?${PY_S}+`,
  'u',
)
const LEADING_PUNCT_RE = new RegExp(`^${PY_S}*[|–—]${PY_S}+`, 'u')

/**
 * Trailing run time: "... (3:45)" or "... [03:45]". A bare trailing "3:45" is not
 * consumed — too easy to swallow a real title such as "9:30".
 */
const TRAILING_DURATION_RE = new RegExp(
  `${PY_S}*[[(]${PY_S}*((?:\\d{1,2}:)?\\d{1,2}:[0-5]\\d)${PY_S}*[\\])]${PY_S}*$`,
  'u',
)
const TRAILING_ISRC_RE = new RegExp(
  `${PY_S}*[[(]?${PY_S}*(?:ISRC[:${PY_WS}]*)?` +
    // `PY_WS` and not `PY_S` inside a character class: `PY_S` is already bracketed, so
    // `[-${PY_S}]` nests one class inside another and JavaScript reads it as a lone
    // quantifier bracket. The whole module failed to load.
    `([A-Za-z]{2}[A-Za-z0-9]{3}[-${PY_WS}]?\\d{2}[-${PY_WS}]?\\d{5})` +
    `${PY_S}*[\\])]?${PY_S}*$`,
  'u',
)

/** `line` with its first `consumed` characters removed. */
function advance(line: Line, consumed: number): Line {
  return makeLine(line.text.slice(consumed), line.offset + consumed)
}

/** Python's `str.lstrip()`. */
const LSTRIP_RE = new RegExp(`^${PY_S}+`, 'u')

export interface Stripped {
  readonly line: Line
  readonly hints: Hints
}

/**
 * Peel ordinals, bullets and cue timestamps off the front of a line.
 *
 * Applied repeatedly, so `"3. [00:14] Artist - Title"` yields position 3, timestamp
 * 14 s, and a line starting at `"Artist"`.
 */
export function stripPrefixes(line: Line): Stripped {
  let position: number | null = null
  let timestampS: number | null = null
  let current = line

  while (current.text) {
    const ordinal = ORDINAL_RE.exec(current.text) ?? BRACKET_ORDINAL_RE.exec(current.text)
    if (ordinal && position === null) {
      // Zero-indexed lists exist ("0. ..."). The marker is still scaffolding and is
      // consumed, but `position` is a 1-based ordinal, so 0 is not recorded. Found by
      // Hypothesis at M0: recording 0 violated the model and 500'd /parse.
      const value = Number(ordinal[1])
      position = value >= 1 ? value : null
      current = advance(current, ordinal[0].length)
      continue
    }

    const stamp = TIMESTAMP_RE.exec(current.text)
    if (stamp && timestampS === null) {
      const seconds = parseDuration(stamp[1]!)
      if (seconds !== null) {
        timestampS = Math.trunc(seconds)
        current = advance(current, stamp[0].length)
        continue
      }
    }

    const bullet = BULLET_RE.exec(current.text)
    if (bullet) {
      current = advance(current, bullet[0].length)
      continue
    }

    const leading = LEADING_PUNCT_RE.exec(current.text)
    if (leading) {
      current = advance(current, leading[0].length)
      continue
    }
    break
  }

  // Drop any remaining indentation so spans start at the first real character.
  const stripped = current.text.replace(LSTRIP_RE, '')
  current = advance(current, current.text.length - stripped.length)

  return { line: current, hints: makeHints({ position, timestampS }) }
}

/** Python's `str.rstrip(" \t.,;")`. */
function rstripPunct(value: string): string {
  const drop = new Set([' ', '\t', '.', ',', ';'])
  let end = value.length
  while (end > 0 && drop.has(value[end - 1]!)) end -= 1
  return value.slice(0, end)
}

/** Peel a trailing run time and ISRC off the end of a line. */
export function stripSuffixes(line: Line): Stripped {
  let text = line.text
  let durationS: number | null = null
  let isrc: string | null = null

  // At most one duration and one ISRC, in either order.
  for (let round = 0; round < 2; round += 1) {
    const isrcMatch = TRAILING_ISRC_RE.exec(text)
    if (isrcMatch && isrc === null) {
      const candidate = normalizeIsrc(isrcMatch[1]!)
      if (candidate !== null) {
        isrc = candidate
        text = text.slice(0, isrcMatch.index)
        continue
      }
    }

    const durationMatch = TRAILING_DURATION_RE.exec(text)
    if (durationMatch && durationS === null) {
      durationS = parseDuration(durationMatch[1]!)
      if (durationS !== null) {
        text = text.slice(0, durationMatch.index)
        continue
      }
    }
    break
  }

  return {
    line: makeLine(rstripPunct(text), line.offset),
    hints: makeHints({ durationS, isrc }),
  }
}
