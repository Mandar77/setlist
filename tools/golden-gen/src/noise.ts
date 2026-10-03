/**
 * Damage applied to rendered text: typos, casing, emoji, invisible characters.
 *
 * Every mutation here is reversible in the sense that matters — `fold()` transliterates,
 * lowercases and drops punctuation before comparing — or it is confined to a case scored
 * on precision rather than recall. That boundary is the whole design: a typo inside a
 * title changes what the right answer *is*, and asserting the parser should recover the
 * original spelling would be asserting it can read minds.
 *
 * So casing and emoji and zero-width characters go into cases the extractor is expected
 * to get right, because folding removes them. Character-level typos go into noisy cases,
 * where the only requirement is that nothing is invented.
 */

import type { Rng } from './rng.js'

/** Characters that are invisible, legal in the input, and change string length. */
const ZERO_WIDTH = ['​', '‌', '‍', '﻿']

/** Emoji people actually put in music posts. */
const EMOJI = ['🔥', '🎶', '💿', '✨', '🙌', '🎸', '😭', '🥁']

/** Keyboard neighbours, for typos that look like typos rather than like noise. */
const NEIGHBOURS: Readonly<Record<string, string>> = {
  a: 's',
  e: 'r',
  i: 'o',
  o: 'p',
  u: 'y',
  n: 'm',
  s: 'd',
  t: 'y',
  r: 't',
  l: 'k',
}

/** UPPER, lower, or Title Case, applied to whole lines. */
export function reCase(rng: Rng, text: string): string {
  const mode = rng.pick(['upper', 'lower', 'title', 'mixed'])
  return text
    .split('\n')
    .map(line => {
      if (line.trim() === '') return line
      switch (mode) {
        case 'upper':
          return line.toUpperCase()
        case 'lower':
          return line.toLowerCase()
        case 'title':
          return line.replace(/\b\p{L}/gu, c => c.toUpperCase())
        default:
          // Alternating caps, the shape a sarcastic post takes. Folding removes it.
          return [...line].map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c.toLowerCase())).join('')
      }
    })
    .join('\n')
}

/** Drop emoji into the text, at line ends and occasionally mid-line. */
export function addEmoji(rng: Rng, text: string): string {
  return text
    .split('\n')
    .map(line => {
      if (line.trim() === '' || !rng.chance(0.5)) return line
      return rng.chance(0.7) ? `${line} ${rng.pick(EMOJI)}` : `${rng.pick(EMOJI)} ${line}`
    })
    .join('\n')
}

/**
 * Insert zero-width characters.
 *
 * These matter more than they look. NFKC normalization and zero-width stripping both
 * change string length, which is exactly why ADR-007 says spans index the *normalized*
 * text — a golden case carrying them is a case that fails if anyone ever computes an
 * offset against the raw input.
 */
export function addZeroWidth(rng: Rng, text: string): string {
  const chars = [...text]
  const howMany = Math.max(1, Math.floor(chars.length / 60))
  for (let i = 0; i < howMany; i += 1) {
    chars.splice(rng.int(0, chars.length), 0, rng.pick(ZERO_WIDTH))
  }
  return chars.join('')
}

/** Fullwidth forms, which NFKC folds back to ASCII. */
export function toFullwidth(rng: Rng, text: string): string {
  return [...text]
    .map(c => {
      const code = c.codePointAt(0)
      if (code === undefined || code < 0x21 || code > 0x7e) return c
      return rng.chance(0.4) ? String.fromCodePoint(code + 0xfee0) : c
    })
    .join('')
}

/**
 * Character-level typos: swaps, drops, doubles and neighbour substitutions.
 *
 * Only ever applied to cases scored on precision. A typo in a title changes the truth,
 * and a golden case that says "the parser should have known I meant Hoppípolla" is a
 * case asserting something nobody promised.
 */
export function addTypos(rng: Rng, text: string, rate = 0.02): string {
  const chars = [...text]
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const c = chars[i]!
    if (c === '\n' || !rng.chance(rate)) continue
    switch (rng.int(0, 3)) {
      case 0: // drop
        chars.splice(i, 1)
        break
      case 1: // double
        chars.splice(i, 0, c)
        break
      case 2: // swap with the next
        if (i + 1 < chars.length && chars[i + 1] !== '\n') {
          ;[chars[i], chars[i + 1]] = [chars[i + 1]!, c]
        }
        break
      default: {
        const lower = c.toLowerCase()
        const neighbour = NEIGHBOURS[lower]
        if (neighbour !== undefined) chars[i] = c === lower ? neighbour : neighbour.toUpperCase()
      }
    }
  }
  return chars.join('')
}

/** Ragged whitespace: trailing spaces, tabs for indents, the odd double blank line. */
export function ragWhitespace(rng: Rng, text: string): string {
  return text
    .split('\n')
    .map(line => {
      if (line.trim() === '') return line
      let out = line
      if (rng.chance(0.3)) out = `${' '.repeat(rng.int(1, 3))}${out}`
      if (rng.chance(0.3)) out = `${out}${' '.repeat(rng.int(1, 3))}`
      if (rng.chance(0.15)) out = out.replace(/ /, '\t')
      return out
    })
    .join('\n')
}
