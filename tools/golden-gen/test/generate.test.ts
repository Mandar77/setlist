/**
 * The generator's own properties — determinism, and the truth rules that make the
 * corpus a test rather than a transcript.
 *
 * The accuracy gate in `tests/accuracy` scores the extractor against the generated
 * corpus. Nothing there would notice if the corpus were silently wrong: a generator that
 * produced the same mistaken expectation every run would make the gate fail in a way
 * that looks like an extractor problem. These tests are what stands between those two
 * failure modes.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { CORPUS_SEED, generate, serialize } from '../src/generate.js'
import { Rng } from '../src/rng.js'
import { loadSeed, type SeedRow } from '../src/seed.js'
import { featuredArtists, isUsable, primaryArtist, truthFor } from '../src/truth.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SEED_PATH = resolve(repoRoot, 'golden', 'seed', 'recordings.jsonl')
const OUT_PATH = resolve(repoRoot, 'golden', 'extraction', 'generated.json')

const seedRows = loadSeed(SEED_PATH)

function credited(...parts: [string, string][]): SeedRow {
  return {
    recording_mbid: 'rec',
    title: 'Song',
    version: '',
    artist: parts
      .map(([n, j]) => `${n}${j}`)
      .join('')
      .trim(),
    artists: parts.map(([name, join], i) => ({ name, mbid: `a${i}`, join })),
    isrc: null,
    isrcs: [],
    duration_ms: null,
    release_mbid: 'rel',
    release_title: 'Album',
    release_date: null,
    tags: [],
  }
}

// ------------------------------------------------------------------ determinism

describe('determinism', () => {
  it('produces identical output for the same seed', () => {
    expect(serialize(generate(seedRows, 1234))).toBe(serialize(generate(seedRows, 1234)))
  })

  it('produces different output for a different seed', () => {
    // Otherwise the seed is decorative and the first test above proves nothing.
    expect(serialize(generate(seedRows, 1234))).not.toBe(serialize(generate(seedRows, 5678)))
  })

  it('matches the committed corpus', () => {
    // The staleness check `make golden-check` runs, as a test, so a corpus that drifted
    // from its generator fails the unit suite too.
    expect(readFileSync(OUT_PATH, 'utf8')).toBe(serialize(generate(seedRows, CORPUS_SEED)))
  })

  it('does not depend on the order the recipes happen to consume the rng', () => {
    // A generator that read the clock, the filesystem or Math.random would pass the
    // first test only by accident. Two fresh Rngs from one seed must agree exactly.
    const a = new Rng(42)
    const b = new Rng(42)
    expect(Array.from({ length: 50 }, () => a.next())).toEqual(
      Array.from({ length: 50 }, () => b.next()),
    )
  })
})

// ------------------------------------------------------------------ truth

describe('expected answers come from the seed', () => {
  it('takes the primary credit, not the whole credit line, when there is a feature', () => {
    const row = credited(['Calvin Harris', ' feat. '], ['Dua Lipa', ''])
    expect(primaryArtist(row)).toBe('Calvin Harris')
    expect(featuredArtists(row)).toEqual(['Dua Lipa'])
  })

  it('leaves collaboration joiners inside the primary credit', () => {
    // `split_artist_credits` documents this: `&`, `x` and `and` are part of the credit
    // as providers spell it, and splitting them would hurt matching. "Amadou & Mariam"
    // is one act, not a feature.
    for (const join of [' & ', ' and ', ' x ', ' with ']) {
      const row = credited(['Amadou', join], ['Mariam', ''])
      expect(primaryArtist(row)).toBe(`Amadou${join}Mariam`.trim())
      expect(featuredArtists(row)).toEqual([])
    }
  })

  it('splits at the first feature when several credits precede it', () => {
    const row = credited(['David Guetta', ' & '], ['Tocadisco', ' feat. '], ['Chris Willis', ''])
    expect(primaryArtist(row)).toBe('David Guetta & Tocadisco')
    expect(featuredArtists(row)).toEqual(['Chris Willis'])
  })

  it('keeps the seed title verbatim', () => {
    const row = { ...credited(['Someone', '']), title: 'Hoppípolla' }
    expect(truthFor(row).title).toBe('Hoppípolla')
  })
})

describe('rows that would make dishonest cases are excluded', () => {
  it('drops a title that already carries its own annotation', () => {
    // The extractor peels "(TJR remix)" into hints and returns "Too Original"; the seed
    // says the title is "Too Original (TJR remix)". Both readings are defensible, so a
    // case built on the row would assert a disagreement about the contract rather than
    // test extraction.
    expect(isUsable({ ...credited(['A', '']), title: 'Too Original (TJR remix)' })).toBe(false)
    expect(isUsable({ ...credited(['A', '']), title: 'Too Original' })).toBe(true)
  })

  it('drops a title containing a separator the renderers use', () => {
    expect(isUsable({ ...credited(['A', '']), title: 'Black - White' })).toBe(false)
    expect(isUsable({ ...credited(['A', '']), title: 'Song by Someone' })).toBe(false)
  })

  it('drops a title with no letters in it', () => {
    expect(isUsable({ ...credited(['A', '']), title: '1' })).toBe(false)
    expect(isUsable({ ...credited(['A', '']), title: '(...)' })).toBe(false)
  })

  it('keeps ordinary non-Latin titles', () => {
    // The exclusions must not quietly remove the hardest and most valuable rows.
    for (const title of ['最後的戰役', 'Печаль', 'きみについて', 'Σε πόσα ταμπλώ']) {
      expect(isUsable({ ...credited(['A', '']), title })).toBe(true)
    }
  })
})

// ------------------------------------------------------------------ the corpus

describe('the generated corpus', () => {
  const cases = generate(seedRows, CORPUS_SEED)

  it('has at least the 300 cases CORE-03 asks for', () => {
    expect(cases.length).toBeGreaterThanOrEqual(300)
  })

  it('covers every shape the requirement names', () => {
    const names = new Set(cases.map(c => c.id.replace(/-\d+$/, '')))
    for (const required of [
      'numbered-dash',
      'bulleted-dash',
      'bare-dash',
      'by-form',
      'csv-header',
      'csv-headerless',
      'timestamps',
      'title-first-qualified',
      'title-first-ambiguous',
      'qualified',
      'featured',
      'multilingual',
      'live-set',
      'emoji-trailing',
      'emoji-leading',
      'odd-casing',
      'zero-width',
      'fullwidth',
      'ragged-whitespace',
      'reddit-thread',
      'chat-prose',
      'typo-heavy',
    ]) {
      expect(names, `missing recipe ${required}`).toContain(required)
    }
  })

  it('never claims a song whose title is absent from the text it generated', () => {
    // The generator's own grounding check. A renderer that dropped a row while leaving
    // it in `expected` would hand the accuracy gate an unsatisfiable case, and the gate
    // would report it as an extractor failure.
    // Two recipes rewrite characters on purpose and are excluded: `typo-heavy` damages
    // the text, and `fullwidth` shifts codepoints that NFKC folds back later. A third,
    // `zero-width`, inserts invisible characters *inside* titles — which is exactly the
    // case worth generating, and exactly why the haystack is stripped of them before
    // the comparison rather than the recipe being skipped.
    // Built from a string so Prettier cannot rewrite the escapes into the literal
    // invisible characters they stand for, which it does, and which ESLint then
    // rejects as irregular whitespace.
    const invisible = new RegExp('[\u200b-\u200d\ufeff]', 'g')
    for (const c of cases) {
      if (c.id.startsWith('typo-heavy') || c.id.startsWith('fullwidth')) continue
      const haystack = c.text.replace(invisible, '').toLowerCase()
      for (const song of c.expected) {
        const needle = song.title.replace(invisible, '').toLowerCase()
        expect(haystack, `${c.id}: expected "${song.title}" is not in the text`).toContain(needle)
      }
    }
  })

  it('has unique ids', () => {
    const ids = cases.map(c => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every case at least three songs', () => {
    for (const c of cases) expect(c.expected.length).toBeGreaterThanOrEqual(3)
  })
})
