// Weekly re-match idempotency (M6-02).
//
// "Ran twice" is a normal event for a Standard workflow — an operator reruns it, the
// scheduler retries, a run resumes after a partial failure — so the second run producing
// the same state as the first is a requirement rather than a nicety.

import { describe, expect, it, vi } from 'vitest'

import type { Qualifier } from '@setlist/core'

import {
  type Candidate,
  type Lookup,
  Matcher,
  type RematchItem,
  TokenBucket,
  fingerprint,
  rematch,
} from '../src/index.js'

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  title: 'One More Time',
  artist: 'Daft Punk',
  durationS: 320,
  qualifiers: [],
  ...over,
})

const item = (itemId: string, over: Partial<RematchItem> = {}): RematchItem => ({
  itemId,
  title: 'One More Time',
  artist: 'Daft Punk',
  isrc: null,
  durationS: 320,
  qualifiers: [] as Qualifier[],
  ...over,
})

function matcherFor(candidates: readonly Candidate[]): Matcher {
  const primary: Lookup = {
    byIsrc: async () => null,
    search: async () => candidates,
  }
  return new Matcher({ primary, bucket: new TokenBucket(0) })
}

describe('a first run writes', () => {
  it('returns an update for an item with no stored match', async () => {
    const outcome = await rematch([item('i1')], new Map(), matcherFor([candidate()]))
    expect(outcome.updated).toHaveLength(1)
    expect(outcome.unchanged).toEqual([])
    expect(outcome.updated[0]?.itemId).toBe('i1')
  })

  it('reports an item the catalogs still cannot place', async () => {
    const outcome = await rematch([item('i1')], new Map(), matcherFor([]))
    expect(outcome.stillUnmatched).toEqual(['i1'])
    expect(outcome.updated).toEqual([])
  })
})

describe('a rerun is a no-op', () => {
  it('writes nothing the second time', async () => {
    const first = await rematch([item('i1')], new Map(), matcherFor([candidate()]))
    const stored = new Map(first.updated.map(m => [m.itemId, m]))

    const second = await rematch([item('i1')], stored, matcherFor([candidate()]))
    expect(second.updated).toEqual([])
    expect(second.unchanged).toEqual(['i1'])
  })

  it('a third run is still a no-op', async () => {
    const first = await rematch([item('i1')], new Map(), matcherFor([candidate()]))
    const stored = new Map(first.updated.map(m => [m.itemId, m]))
    await rematch([item('i1')], stored, matcherFor([candidate()]))
    const third = await rematch([item('i1')], stored, matcherFor([candidate()]))
    expect(third.updated).toEqual([])
  })

  it('writes again when the catalog answer actually changes', async () => {
    // The other half: idempotent must not mean inert. A recording that was unmatched
    // last week and is matched this week is exactly what re-matching is for.
    const first = await rematch([item('i1')], new Map(), matcherFor([]))
    expect(first.stillUnmatched).toEqual(['i1'])

    const second = await rematch([item('i1')], new Map(), matcherFor([candidate()]))
    expect(second.updated).toHaveLength(1)
  })

  it('writes again when the match changes to a different recording', async () => {
    const first = await rematch([item('i1')], new Map(), matcherFor([candidate()]))
    const stored = new Map(first.updated.map(m => [m.itemId, m]))

    const moved = await rematch(
      [item('i1')],
      stored,
      matcherFor([candidate({ title: 'One More Time (Remastered)' })]),
    )
    expect(moved.updated).toHaveLength(1)
    expect(moved.unchanged).toEqual([])
  })
})

describe('the fingerprint', () => {
  it('ignores a score that moved without the match moving', async () => {
    // Treating a 0.91 to 0.9100001 drift as a change would make every weekly run
    // rewrite every row, and every write is a WCU against a provisioned table.
    const a = {
      scored: {
        candidate: candidate(),
        score: 0.91,
        verdict: 'auto_accept' as const,
        parts: {} as never,
      },
      source: 'text' as const,
      orientationFlipped: false,
      orientationOutcome: 'not_applicable' as const,
    }
    const b = { ...a, scored: { ...a.scored, score: 0.9100001 } }
    expect(fingerprint(a)).toBe(fingerprint(b))
  })

  it('changes when the verdict changes', async () => {
    const a = {
      scored: {
        candidate: candidate(),
        score: 0.9,
        verdict: 'auto_accept' as const,
        parts: {} as never,
      },
      source: 'text' as const,
      orientationFlipped: false,
      orientationOutcome: 'not_applicable' as const,
    }
    const b = { ...a, scored: { ...a.scored, verdict: 'review' as const } }
    expect(fingerprint(a)).not.toBe(fingerprint(b))
  })

  it('changes when the orientation outcome changes', async () => {
    const a = {
      scored: {
        candidate: candidate(),
        score: 0.9,
        verdict: 'auto_accept' as const,
        parts: {} as never,
      },
      source: 'text' as const,
      orientationFlipped: false,
      orientationOutcome: 'resolved' as const,
    }
    const b = { ...a, orientationOutcome: 'unresolved' as const }
    expect(fingerprint(a)).not.toBe(fingerprint(b))
  })
})

describe('a batch', () => {
  it('separates the three outcomes', async () => {
    const matched = await rematch([item('i1')], new Map(), matcherFor([candidate()]))
    const stored = new Map(matched.updated.map(m => [m.itemId, m]))

    const outcome = await rematch(
      [item('i1'), item('i2'), item('i3', { title: 'Nothing Here', artist: 'Nobody' })],
      stored,
      {
        match: vi
          .fn()
          .mockResolvedValueOnce({
            scored: {
              candidate: candidate(),
              score: 1,
              verdict: 'auto_accept' as const,
              parts: {} as never,
            },
            source: 'text',
            orientationFlipped: false,
            orientationOutcome: 'not_applicable',
          })
          .mockResolvedValueOnce({
            scored: {
              candidate: candidate(),
              score: 1,
              verdict: 'auto_accept' as const,
              parts: {} as never,
            },
            source: 'text',
            orientationFlipped: false,
            orientationOutcome: 'not_applicable',
          })
          .mockResolvedValueOnce({
            scored: null,
            source: null,
            orientationFlipped: false,
            orientationOutcome: 'not_applicable',
          }),
      } as unknown as Matcher,
    )

    expect(outcome.unchanged).toEqual(['i1'])
    expect(outcome.updated.map(u => u.itemId)).toEqual(['i2'])
    expect(outcome.stillUnmatched).toEqual(['i3'])
  })
})
