/**
 * The seed gate, checked against files that must pass and files that must fail.
 *
 * CORE-02's requirements are properties of the committed file rather than of the code
 * that wrote it, so the only way they stay true is a check that reads the file — and the
 * only way to know that check works is to hand it a file that breaks each requirement
 * and watch it say so. The first harvest produced exactly one `remaster` row and the
 * number went unnoticed until somebody counted; a floor of one is a floor that never
 * fires.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { MIN_ISRC_SHARE, MIN_ROWS, parse, problems, summarize } from '../src/verify.js'
import type { SeedRow } from '../src/row.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SEED_PATH = resolve(repoRoot, 'golden', 'seed', 'recordings.jsonl')

/** A row good enough to pass, parameterised so a test can break exactly one thing. */
function row(index: number, over: Partial<SeedRow> = {}): SeedRow {
  const mbid = `mbid-${String(index).padStart(5, '0')}`
  return {
    recording_mbid: mbid,
    title: `Song ${index}`,
    version: '',
    artist: 'Someone',
    artists: [{ name: 'Someone', mbid: 'artist-1', join: '' }],
    isrc: 'GBAAA0000001',
    isrcs: ['GBAAA0000001'],
    duration_ms: 200000,
    release_mbid: 'rel-1',
    release_title: 'Album',
    release_date: '2001-01-01',
    tags: [],
    ...over,
  }
}

/** A file that satisfies every floor, so a test can break one thing at a time. */
function goodRows(count = MIN_ROWS + 50): SeedRow[] {
  return Array.from({ length: count }, (_, i) => {
    const tags: SeedRow['tags'][number][] = []
    if (i % 7 === 0) tags.push('live')
    if (i % 9 === 0) tags.push('remaster')
    if (i % 8 === 0) tags.push('feat')
    if (i % 5 === 0) tags.push('non_latin')
    return row(i, { tags })
  })
}

describe('the committed seed', () => {
  it('passes its own gate', () => {
    expect(problems(parse(readFileSync(SEED_PATH, 'utf8')))).toEqual([])
  })

  it('is big enough, and reports what it found', () => {
    const rows = parse(readFileSync(SEED_PATH, 'utf8'))
    expect(rows.length).toBeGreaterThanOrEqual(MIN_ROWS)
    expect(summarize(rows)).toMatch(/rows, \d+ with an ISRC/)
  })
})

describe('the gate rejects', () => {
  it('a file with too few rows', () => {
    expect(problems(goodRows(10)).join()).toMatch(/expected at least/)
  })

  it('ISRC coverage below the floor', () => {
    const rows = goodRows()
    // Strip ISRCs from just over the allowed share.
    const strip = Math.ceil(rows.length * (1 - MIN_ISRC_SHARE)) + 10
    const broken = rows.map((r, i) => (i < strip ? { ...r, isrc: null, isrcs: [] } : r))
    expect(problems(broken).join()).toMatch(/below the 80% floor/)
  })

  it.each(['live', 'remaster', 'feat', 'non_latin'])('a seed with no %s rows', tag => {
    const broken = goodRows().map(r => ({ ...r, tags: r.tags.filter(t => t !== tag) }))
    expect(problems(broken).join()).toMatch(new RegExp(`tagged ${tag}`))
  })

  it('a malformed ISRC', () => {
    const broken = goodRows()
    broken[0] = row(0, { isrc: 'not-an-isrc', isrcs: ['not-an-isrc'] })
    expect(problems(broken).join()).toMatch(/malformed ISRC/)
  })

  it('a canonical ISRC missing from the list it claims to come from', () => {
    const broken = goodRows()
    broken[0] = row(0, { isrc: 'GBAAA0000009', isrcs: ['GBAAA0000001'] })
    expect(problems(broken).join()).toMatch(/not in the isrcs list/)
  })

  it('an empty title', () => {
    const broken = goodRows()
    broken[0] = row(0, { title: '   ' })
    expect(problems(broken).join()).toMatch(/empty title/)
  })

  it('a duplicate recording', () => {
    const broken = goodRows()
    broken[1] = { ...broken[1]!, recording_mbid: broken[0]!.recording_mbid }
    expect(problems(broken).join()).toMatch(/duplicate recording_mbid/)
  })

  it('a file that is not sorted', () => {
    const rows = goodRows()
    const swapped = [rows[5]!, ...rows.slice(0, 5), ...rows.slice(6)]
    expect(problems(swapped).join()).toMatch(/not sorted/)
  })

  it('a line that is not JSON', () => {
    expect(() => parse('{"a":1}\nnot json\n')).toThrow(/line 2/)
  })
})
